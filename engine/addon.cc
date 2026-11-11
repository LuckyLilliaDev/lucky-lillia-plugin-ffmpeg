#define NAPI_VERSION 8
#include <node_api.h>
#include <algorithm>
#include <array>
#include <chrono>
#include <cmath>
#include <cstdint>
#include <cstring>
#include <filesystem>
#include <fstream>
#include <limits>
#include <memory>
#include <stdexcept>
#include <string>
#include <vector>

extern "C" {
#include <libavcodec/avcodec.h>
#include <libavformat/avformat.h>
#include <libavutil/avutil.h>
#include <libavutil/audio_fifo.h>
#include <libavutil/channel_layout.h>
#include <libavutil/imgutils.h>
#include <libavutil/opt.h>
#include <libswresample/swresample.h>
#include <libswscale/swscale.h>
#include <SKP_Silk_SDK_API.h>
#include <SKP_Silk_structs.h>
}

namespace {
constexpr size_t max_audio_bytes = 256 * 1024 * 1024;
constexpr int max_video_pixels = 64 * 1024 * 1024;

void check(int result, const char* operation) {
  if (result >= 0) return;
  char message[AV_ERROR_MAX_STRING_SIZE];
  av_strerror(result, message, sizeof(message));
  throw std::runtime_error(std::string(operation) + ": " + message);
}
void napi_check(napi_env env, napi_status status) {
  if (status == napi_ok) return;
  const napi_extended_error_info* info = nullptr;
  napi_get_last_error_info(env, &info);
  throw std::runtime_error(info && info->error_message ? info->error_message : "Node-API failure");
}

struct Frame {
  AVFrame* value = av_frame_alloc();
  Frame() { if (!value) throw std::bad_alloc(); }
  ~Frame() { av_frame_free(&value); }
};
struct Packet {
  AVPacket* value = av_packet_alloc();
  Packet() { if (!value) throw std::bad_alloc(); }
  ~Packet() { av_packet_free(&value); }
};
struct Codec {
  AVCodecContext* value = nullptr;
  ~Codec() { avcodec_free_context(&value); }
};
struct Resampler {
  SwrContext* value = nullptr;
  ~Resampler() { swr_free(&value); }
};
struct Scaler {
  SwsContext* value = nullptr;
  ~Scaler() { sws_freeContext(value); }
};
struct Input {
  AVFormatContext* value = nullptr;
  ~Input() { avformat_close_input(&value); }
};
struct Output {
  AVFormatContext* value = nullptr;
  ~Output() {
    if (!value) return;
    if (!(value->oformat->flags & AVFMT_NOFILE)) avio_closep(&value->pb);
    avformat_free_context(value);
  }
};

enum class Operation { probe, decode, encode, thumbnail, transcode };
struct Task {
  napi_env env = nullptr;
  napi_async_work work = nullptr;
  napi_deferred deferred = nullptr;
  Operation operation;
  std::string input, output, format, error;
  std::vector<uint8_t> bytes;
  int sample_rate = 24000, channels = 1;
  int width = 0, height = 0;
  int max_width = 1280, max_height = 1280;
  double time = 0;
  double duration = 0, size = 0;
  std::chrono::steady_clock::time_point deadline;

  void checkpoint() const {
    if (std::chrono::steady_clock::now() > deadline)
      throw std::runtime_error("FFmpeg operation timed out");
  }
  static int interrupt(void* opaque) {
    auto* task = static_cast<Task*>(opaque);
    return std::chrono::steady_clock::now() > task->deadline;
  }
  void append(const uint8_t* data, size_t length) {
    if (length > max_audio_bytes - bytes.size())
      throw std::runtime_error("Decoded audio exceeds the 256 MiB limit");
    bytes.insert(bytes.end(), data, data + length);
  }
};

constexpr int silk_rate = 24000;
constexpr int silk_frame_samples = silk_rate / 50;
// SDK 1.0.9.6 range-coder payload capacity (MAX_ARITHM_BYTES).
constexpr int silk_max_packet_bytes = 1024;
constexpr char silk_header[] = "#!SILK_V3";
constexpr size_t silk_header_size = sizeof(silk_header) - 1;

void check_silk(int result, const char* operation) {
  if (result != 0) throw std::runtime_error(std::string(operation) + ": SILK error " + std::to_string(result));
}

struct SilkInput {
  std::ifstream stream;
  bool recognized = false;
  uintmax_t size = 0;
  explicit SilkInput(Task& task) {
    const auto filename = std::filesystem::u8path(task.input);
    std::error_code error;
    if (!std::filesystem::is_regular_file(filename, error))
      throw std::runtime_error("Input media must be an existing regular file");
    stream.open(filename, std::ios::binary);
    if (!stream) throw std::runtime_error("Cannot read input media");
    std::array<char, silk_header_size + 1> prefix{};
    stream.read(prefix.data(), prefix.size());
    const auto count = stream.gcount();
    const int offset = count > 0 && prefix[0] == 2 ? 1 : 0;
    recognized = count >= static_cast<std::streamsize>(offset + silk_header_size) &&
      std::memcmp(prefix.data() + offset, silk_header, silk_header_size) == 0;
    if (!recognized) { stream.close(); return; }
    size = std::filesystem::file_size(filename, error);
    if (error || size > max_audio_bytes) throw std::runtime_error("SILK input exceeds the 256 MiB limit");
    stream.clear();
    stream.seekg(offset + silk_header_size);
    if (!stream) throw std::runtime_error("Cannot read SILK header");
  }
};

struct S16Converter {
  Resampler resampler;
  int channels;
  S16Converter(int input_rate, int input_channels, int output_rate, int output_channels) : channels(output_channels) {
    AVChannelLayout input{}, output{};
    av_channel_layout_default(&input, input_channels);
    av_channel_layout_default(&output, output_channels);
    const int result = swr_alloc_set_opts2(&resampler.value, &output, AV_SAMPLE_FMT_S16, output_rate,
      &input, AV_SAMPLE_FMT_S16, input_rate, 0, nullptr);
    av_channel_layout_uninit(&input);
    av_channel_layout_uninit(&output);
    check(result, "Allocate SILK PCM resampler");
    check(swr_init(resampler.value), "Initialize SILK PCM resampler");
  }
  template<typename Consumer>
  int convert(Task& task, const uint8_t* input, int samples, Consumer consume) {
    task.checkpoint();
    int capacity = swr_get_out_samples(resampler.value, samples);
    check(capacity, "Size SILK PCM resampler");
    capacity = std::max(256, capacity);
    if (static_cast<uint64_t>(capacity) * channels * 2 > max_audio_bytes)
      throw std::runtime_error("Resampled SILK audio frame is too large");
    std::vector<SKP_int16> pcm(static_cast<size_t>(capacity) * channels);
    auto* output = reinterpret_cast<uint8_t*>(pcm.data());
    const int count = swr_convert(resampler.value, &output, capacity, samples ? &input : nullptr, samples);
    check(count, "Resample SILK audio");
    if (count) consume(pcm.data(), count);
    return count;
  }
};

template<typename Consumer>
void read_silk(Task& task, SilkInput& input, Consumer consume) {
  SKP_int32 state_size = 0;
  check_silk(SKP_Silk_SDK_Get_Decoder_Size(&state_size), "Size SILK decoder");
  if (state_size != sizeof(SKP_Silk_decoder_state)) throw std::runtime_error("Incompatible SILK decoder state size");
  auto state = std::make_unique<SKP_Silk_decoder_state>();
  check_silk(SKP_Silk_SDK_InitDecoder(state.get()), "Initialize SILK decoder");
  SKP_SILK_SDK_DecControlStruct control{};
  control.API_sampleRate = silk_rate;
  uint64_t total_samples = 0;
  for (;;) {
    task.checkpoint();
    uint8_t length_bytes[2];
    input.stream.read(reinterpret_cast<char*>(length_bytes), 2);
    if (input.stream.gcount() == 0 && input.stream.eof()) break;
    if (input.stream.gcount() != 2 || input.stream.bad()) throw std::runtime_error("Truncated SILK packet length");
    const unsigned length = length_bytes[0] | (static_cast<unsigned>(length_bytes[1]) << 8);
    if (length == 0xffff) {
      char trailing;
      if (input.stream.get(trailing) || !input.stream.eof()) throw std::runtime_error("Data after SILK terminal marker");
      break;
    }
    // The SDK range-decoder initialization reads its first four bytes directly.
    if (length < 4 || length > silk_max_packet_bytes) throw std::runtime_error("Invalid or oversized SILK packet");
    std::vector<uint8_t> packet(length);
    input.stream.read(reinterpret_cast<char*>(packet.data()), packet.size());
    if (input.stream.gcount() != static_cast<std::streamsize>(packet.size()) || input.stream.bad())
      throw std::runtime_error("Truncated SILK packet payload");
    int frames = 0;
    do {
      task.checkpoint();
      // The API emits one 20 ms frame per call, even for a multi-frame packet.
      std::array<SKP_int16, silk_frame_samples * 2> pcm{};
      SKP_int16 samples = static_cast<SKP_int16>(pcm.size());
      check_silk(SKP_Silk_SDK_Decode(state.get(), &control, 0, packet.data(), length, pcm.data(), &samples), "Decode SILK packet");
      if (++frames > 5 || samples != silk_frame_samples)
        throw std::runtime_error("Invalid SILK packet frame count");
      // SDK 1.0.9.6 can replace a payload error with its resampler result.
      // Inspect its pinned, unmodified state so concealed corrupt frames do
      // not become successful output. Do not use the unbounded SDK get_TOC.
      if (state->sRC.error || state->nFramesDecoded != frames)
        throw std::runtime_error("Corrupt SILK packet payload");
      total_samples += samples;
      if (total_samples > max_audio_bytes / 2) throw std::runtime_error("Decoded SILK audio exceeds the 256 MiB limit");
      consume(pcm.data(), samples);
    } while (control.moreInternalDecoderFrames);
    // The SDK stops after five frames even if the payload requests a sixth.
    if (state->FrameTermination == SKP_SILK_MORE_FRAMES ||
        control.framesPerPacket != frames || control.frameSize != silk_frame_samples)
      throw std::runtime_error("SILK packet did not decode completely");
  }
  if (!total_samples) throw std::runtime_error("SILK input contains no audio frames");
  task.duration = static_cast<double>(total_samples) / silk_rate;
  task.size = static_cast<double>(input.size);
}

void decode_silk(Task& task, SilkInput& input) {
  S16Converter converter(silk_rate, 1, task.sample_rate, task.channels);
  auto append = [&](const SKP_int16* pcm, int samples) {
    task.append(reinterpret_cast<const uint8_t*>(pcm), static_cast<size_t>(samples) * task.channels * 2);
  };
  read_silk(task, input, [&](const SKP_int16* pcm, int samples) {
    converter.convert(task, reinterpret_cast<const uint8_t*>(pcm), samples, append);
  });
  while (converter.convert(task, nullptr, 0, append)) {}
}

void encode_silk(Task& task) {
  SKP_int32 state_size = 0;
  check_silk(SKP_Silk_SDK_Get_Encoder_Size(&state_size), "Size SILK encoder");
  if (state_size <= 0) throw std::runtime_error("Invalid SILK encoder state size");
  std::vector<uint8_t> state(static_cast<size_t>(state_size));
  SKP_SILK_SDK_EncControlStruct control{};
  check_silk(SKP_Silk_SDK_InitEncoder(state.data(), &control), "Initialize SILK encoder");
  control.API_sampleRate = silk_rate;
  control.maxInternalSampleRate = silk_rate;
  control.packetSize = silk_frame_samples;
  control.bitRate = 24000;
  control.packetLossPercentage = 0;
  control.complexity = 2;
  control.useInBandFEC = 0;
  control.useDTX = 0;
  const int input_samples = static_cast<int>(task.bytes.size() / (task.channels * 2));
  const int64_t target_samples = av_rescale_rnd(input_samples, silk_rate, task.sample_rate, AV_ROUND_UP);
  if (target_samples <= 0 || static_cast<uint64_t>(target_samples) > max_audio_bytes / 2)
    throw std::runtime_error("Normalized SILK PCM exceeds the 256 MiB limit");
  std::vector<uint8_t> encoded{ 2 };
  encoded.insert(encoded.end(), silk_header, silk_header + silk_header_size);
  std::array<SKP_int16, silk_frame_samples> frame{};
  int filled = 0;
  int64_t converted_samples = 0;
  auto packet = [&]() {
    task.checkpoint();
    std::array<uint8_t, silk_max_packet_bytes> payload{};
    SKP_int16 length = static_cast<SKP_int16>(payload.size());
    check_silk(SKP_Silk_SDK_Encode(state.data(), &control, frame.data(), silk_frame_samples, payload.data(), &length), "Encode SILK packet");
    if (length < 4 || length > silk_max_packet_bytes) throw std::runtime_error("Invalid encoded SILK packet size");
    if (encoded.size() + length + 2 > max_audio_bytes) throw std::runtime_error("Encoded SILK audio exceeds the 256 MiB limit");
    encoded.push_back(static_cast<uint8_t>(length));
    encoded.push_back(static_cast<uint8_t>(length >> 8));
    encoded.insert(encoded.end(), payload.data(), payload.data() + length);
    filled = 0;
  };
  auto consume = [&](const SKP_int16* pcm, int samples) {
    samples = static_cast<int>(std::min<int64_t>(samples, target_samples - converted_samples));
    converted_samples += samples;
    while (samples) {
      const int count = std::min(samples, silk_frame_samples - filled);
      std::copy_n(pcm, count, frame.data() + filled);
      pcm += count;
      samples -= count;
      filled += count;
      if (filled == silk_frame_samples) packet();
    }
  };
  S16Converter converter(task.sample_rate, task.channels, silk_rate, 1);
  for (int position = 0; position < input_samples;) {
    const int count = std::min(4096, input_samples - position);
    converter.convert(task, task.bytes.data() + static_cast<size_t>(position) * task.channels * 2, count, consume);
    position += count;
  }
  while (converter.convert(task, nullptr, 0, consume)) {}
  // Very short resampler input can leave a fractional final sample. Preserve
  // its duration, then zero-pad the last SILK frame to exactly 20 milliseconds.
  const std::array<SKP_int16, silk_frame_samples> silence{};
  while (converted_samples < target_samples)
    consume(silence.data(), static_cast<int>(std::min<int64_t>(silk_frame_samples, target_samples - converted_samples)));
  if (filled) {
    std::fill(frame.begin() + filled, frame.end(), 0);
    packet();
  }
  std::ofstream output(std::filesystem::u8path(task.output), std::ios::binary | std::ios::trunc);
  if (!output) throw std::runtime_error("Cannot open SILK output");
  for (size_t position = 0; position < encoded.size();) {
    task.checkpoint();
    const size_t count = std::min<size_t>(65536, encoded.size() - position);
    output.write(reinterpret_cast<const char*>(encoded.data() + position), count);
    if (!output) throw std::runtime_error("Cannot write SILK output");
    position += count;
  }
  output.close();
  if (!output) throw std::runtime_error("Cannot close SILK output");
  task.bytes.clear();
}

void open_input(Task& task, Input& input) {
  std::error_code file_error;
  if (!std::filesystem::is_regular_file(std::filesystem::u8path(task.input), file_error))
    throw std::runtime_error("Input media must be an existing regular file");
  input.value = avformat_alloc_context();
  if (!input.value) throw std::bad_alloc();
  input.value->interrupt_callback = { Task::interrupt, &task };
  // Only regular local files are accepted by the JS boundary. Disable protocol
  // indirection in playlists/containers as well. Network protocols are not built.
  AVDictionary* options = nullptr;
  av_dict_set(&options, "protocol_whitelist", "file", 0);
  const int result = avformat_open_input(&input.value, task.input.c_str(), nullptr, &options);
  av_dict_free(&options);
  check(result, "Open media");
  // Stream-info probing may temporarily open decoders before open_decoder().
  // Apply the same pixel limit there so malformed images cannot allocate a
  // huge decoded frame before the normal thumbnail checks run.
  struct DecoderOptions {
    std::vector<AVDictionary*> values;
    ~DecoderOptions() { for (auto& value : values) av_dict_free(&value); }
  } decoder_options{ std::vector<AVDictionary*>(input.value->nb_streams, nullptr) };
  for (auto& value : decoder_options.values) {
    check(av_dict_set_int(&value, "max_pixels", max_video_pixels, 0), "Set decoder pixel limit");
    check(av_dict_set(&value, "threads", "2", 0), "Set decoder thread limit");
  }
  check(avformat_find_stream_info(input.value, decoder_options.values.empty() ? nullptr : decoder_options.values.data()), "Read media metadata");
  for (unsigned int i = 0; i < input.value->nb_streams; ++i) {
    const auto* parameters = input.value->streams[i]->codecpar;
    if (parameters->codec_type == AVMEDIA_TYPE_VIDEO &&
        static_cast<int64_t>(parameters->width) * parameters->height > max_video_pixels)
      throw std::runtime_error("Video frame dimensions exceed 64 megapixels");
  }
}

int open_decoder(Input& input, Codec& codec, AVMediaType media) {
  const AVCodec* decoder = nullptr;
  int stream = av_find_best_stream(input.value, media, -1, -1, &decoder, 0);
  check(stream, media == AVMEDIA_TYPE_VIDEO ? "Find video stream" : "Find audio stream");
  codec.value = avcodec_alloc_context3(decoder);
  if (!codec.value) throw std::bad_alloc();
  check(avcodec_parameters_to_context(codec.value, input.value->streams[stream]->codecpar), "Read codec parameters");
  codec.value->thread_count = 2;
  codec.value->max_pixels = max_video_pixels;
  check(avcodec_open2(codec.value, decoder, nullptr), "Open decoder");
  return stream;
}

template<typename Consumer>
void decode_frames(Task& task, Input& input, Codec& codec, int stream, Consumer consume) {
  Packet packet;
  Frame frame;
  bool done = false;
  auto receive = [&]() {
    while (!done) {
      task.checkpoint();
      const int result = avcodec_receive_frame(codec.value, frame.value);
      if (result == AVERROR(EAGAIN) || result == AVERROR_EOF) return;
      check(result, "Decode frame");
      done = consume(frame.value);
      av_frame_unref(frame.value);
    }
  };
  int read_result = 0;
  while (!done && (read_result = av_read_frame(input.value, packet.value)) >= 0) {
    task.checkpoint();
    if (packet.value->stream_index == stream) {
      const int result = avcodec_send_packet(codec.value, packet.value);
      if (result == AVERROR(EAGAIN)) {
        receive();
        if (!done) check(avcodec_send_packet(codec.value, packet.value), "Send packet");
      } else check(result, "Send packet");
      if (!done) receive();
    }
    av_packet_unref(packet.value);
  }
  if (!done) {
    if (read_result != AVERROR_EOF) check(read_result, "Read media packet");
    check(avcodec_send_packet(codec.value, nullptr), "Flush decoder");
    receive();
  }
}

void probe(Task& task) {
  SilkInput silk(task);
  if (silk.recognized) {
    read_silk(task, silk, [](const SKP_int16*, int) {});
    task.format = "silk";
    return;
  }
  Input input;
  open_input(task, input);
  task.format = input.value->iformat->name;
  // AVFMT_NOFILE demuxers (image2) own their IO and leave pb null.
  int64_t size = input.value->pb ? avio_size(input.value->pb) : -1;
  if (size < 0) {
    std::error_code error;
    const auto file_size = std::filesystem::file_size(std::filesystem::u8path(task.input), error);
    task.size = error ? 0 : static_cast<double>(file_size);
  } else task.size = static_cast<double>(size);
  if (input.value->duration != AV_NOPTS_VALUE)
    task.duration = static_cast<double>(input.value->duration) / AV_TIME_BASE;
  for (unsigned int i = 0; i < input.value->nb_streams; ++i) {
    const auto* stream = input.value->streams[i];
    if (stream->codecpar->codec_type != AVMEDIA_TYPE_VIDEO) continue;
    if (stream->disposition & AV_DISPOSITION_ATTACHED_PIC) continue;
    if (stream->codecpar->width <= 0 || stream->codecpar->height <= 0)
      throw std::runtime_error("Video frame dimensions could not be read");
    task.width = stream->codecpar->width;
    task.height = stream->codecpar->height;
    if (stream->duration != AV_NOPTS_VALUE)
      task.duration = stream->duration * av_q2d(stream->time_base);
    break;
  }
  if (!std::isfinite(task.duration) || task.duration < 0) task.duration = 0;
}

void decode_audio(Task& task) {
  SilkInput silk(task);
  if (silk.recognized) return decode_silk(task, silk);
  Input input;
  Codec codec;
  Resampler resampler;
  open_input(task, input);
  const int stream = open_decoder(input, codec, AVMEDIA_TYPE_AUDIO);
  int source_rate = 0, source_format = -1;
  AVChannelLayout source_layout{};
  struct LayoutCleanup { AVChannelLayout* value; ~LayoutCleanup() { av_channel_layout_uninit(value); } } cleanup{ &source_layout };
  decode_frames(task, input, codec, stream, [&](AVFrame* frame) {
    if (!resampler.value) {
      if (frame->sample_rate <= 0 || !av_channel_layout_check(&frame->ch_layout))
        throw std::runtime_error("Audio stream has invalid sample rate or channel layout");
      source_rate = frame->sample_rate;
      source_format = frame->format;
      check(av_channel_layout_copy(&source_layout, &frame->ch_layout), "Copy channel layout");
      AVChannelLayout layout{};
      av_channel_layout_default(&layout, task.channels);
      const int result = swr_alloc_set_opts2(&resampler.value, &layout, AV_SAMPLE_FMT_S16, task.sample_rate,
        &frame->ch_layout, static_cast<AVSampleFormat>(frame->format), frame->sample_rate, 0, nullptr);
      av_channel_layout_uninit(&layout);
      check(result, "Allocate audio resampler");
      check(swr_init(resampler.value), "Initialize audio resampler");
    } else if (source_rate != frame->sample_rate || source_format != frame->format ||
               av_channel_layout_compare(&source_layout, &frame->ch_layout)) {
      throw std::runtime_error("Audio format changed within the stream");
    }
    const int capacity = static_cast<int>(av_rescale_rnd(swr_get_delay(resampler.value, source_rate) + frame->nb_samples,
      task.sample_rate, source_rate, AV_ROUND_UP));
    if (capacity < 0 || static_cast<uint64_t>(capacity) * task.channels * 2 > max_audio_bytes)
      throw std::runtime_error("Audio frame is too large");
    std::vector<uint8_t> data(static_cast<size_t>(capacity) * task.channels * 2);
    uint8_t* destination = data.data();
    const int samples = swr_convert(resampler.value, &destination, capacity,
      const_cast<const uint8_t**>(frame->extended_data), frame->nb_samples);
    check(samples, "Resample audio");
    task.append(data.data(), static_cast<size_t>(samples) * task.channels * 2);
    return false;
  });
  if (!resampler.value) throw std::runtime_error("No audio frames were decoded");
  for (;;) {
    task.checkpoint();
    uint8_t data[8192];
    uint8_t* destination = data;
    const int samples = swr_convert(resampler.value, &destination, sizeof(data) / (task.channels * 2), nullptr, 0);
    check(samples, "Flush audio resampler");
    if (!samples) break;
    task.append(data, static_cast<size_t>(samples) * task.channels * 2);
  }
}

struct DisplayTransform {
  int a = 1, b = 0, c = 0, d = 1;
  bool swaps_axes() const { return a == 0; }
  bool identity() const { return a == 1 && b == 0 && c == 0 && d == 1; }
};

DisplayTransform display_transform(const AVFrame* frame, const AVCodecParameters* parameters) {
  const uint8_t* data = nullptr;
  size_t size = 0;
  if (const AVFrameSideData* side = av_frame_get_side_data(frame, AV_FRAME_DATA_DISPLAYMATRIX)) {
    data = side->data; size = side->size;
  } else if (const AVPacketSideData* side = av_packet_side_data_get(parameters->coded_side_data,
      parameters->nb_coded_side_data, AV_PKT_DATA_DISPLAYMATRIX)) {
    data = side->data; size = side->size;
  }
  if (!data || size < 9 * sizeof(int32_t)) return {};
  int32_t matrix[9];
  std::memcpy(matrix, data, sizeof(matrix));
  // Normalize the two basis vectors so ordinary container scale factors do not
  // change orientation. The matrix maps source (x,y) to (a*x+c*y,b*x+d*y).
  const double first = std::hypot(static_cast<double>(matrix[0]), matrix[1]);
  const double second = std::hypot(static_cast<double>(matrix[3]), matrix[4]);
  if (first == 0 || second == 0 || matrix[2] != 0 || matrix[5] != 0) return {};
  const double values[] = { matrix[0] / first, matrix[1] / first, matrix[3] / second, matrix[4] / second };
  int normalized[4];
  for (int i = 0; i < 4; ++i) {
    normalized[i] = static_cast<int>(std::round(values[i]));
    if (std::abs(values[i] - normalized[i]) > 0.001) return {};
  }
  DisplayTransform transform{ normalized[0], normalized[1], normalized[2], normalized[3] };
  if (std::abs(transform.a * transform.d - transform.b * transform.c) != 1 ||
      std::abs(transform.a) + std::abs(transform.b) != 1 ||
      std::abs(transform.c) + std::abs(transform.d) != 1) return {};
  return transform;
}

void thumbnail(Task& task) {
  Input input;
  Codec decoder, encoder;
  Scaler scaler;
  open_input(task, input);
  const int stream = open_decoder(input, decoder, AVMEDIA_TYPE_VIDEO);
  if (task.time > 0) {
    check(av_seek_frame(input.value, stream, static_cast<int64_t>(task.time / av_q2d(input.value->streams[stream]->time_base)), AVSEEK_FLAG_BACKWARD), "Seek video frame");
    avcodec_flush_buffers(decoder.value);
  }
  bool found = false;
  decode_frames(task, input, decoder, stream, [&](AVFrame* source) {
    if (task.time > 0 && source->best_effort_timestamp != AV_NOPTS_VALUE &&
        source->best_effort_timestamp * av_q2d(input.value->streams[stream]->time_base) + 0.000001 < task.time) return false;
    if (source->width <= 0 || source->height <= 0 ||
        static_cast<int64_t>(source->width) * source->height > max_video_pixels)
      throw std::runtime_error("Video frame dimensions are invalid or exceed 64 megapixels");
    const auto transform = display_transform(source, input.value->streams[stream]->codecpar);
    const int display_width = transform.swaps_axes() ? source->height : source->width;
    const int display_height = transform.swaps_axes() ? source->width : source->height;
    const double ratio = std::min({1.0, static_cast<double>(task.max_width) / display_width, static_cast<double>(task.max_height) / display_height});
    const int scaled_width = std::max(1, static_cast<int>(source->width * ratio));
    const int scaled_height = std::max(1, static_cast<int>(source->height * ratio));
    const int width = transform.swaps_axes() ? scaled_height : scaled_width;
    const int height = transform.swaps_axes() ? scaled_width : scaled_height;
    const AVCodec* png = avcodec_find_encoder(AV_CODEC_ID_PNG);
    if (!png) throw std::runtime_error("PNG encoder is not available");
    encoder.value = avcodec_alloc_context3(png);
    if (!encoder.value) throw std::bad_alloc();
    encoder.value->width = width;
    encoder.value->height = height;
    encoder.value->pix_fmt = AV_PIX_FMT_RGB24;
    encoder.value->time_base = { 1, 1 };
    check(avcodec_open2(encoder.value, png, nullptr), "Open PNG encoder");
    Frame rgb;
    rgb.value->width = scaled_width;
    rgb.value->height = scaled_height;
    rgb.value->format = AV_PIX_FMT_RGB24;
    check(av_frame_get_buffer(rgb.value, 32), "Allocate thumbnail frame");
    scaler.value = sws_getContext(source->width, source->height, static_cast<AVPixelFormat>(source->format),
      scaled_width, scaled_height, AV_PIX_FMT_RGB24, SWS_BILINEAR, nullptr, nullptr, nullptr);
    if (!scaler.value) throw std::runtime_error("Cannot create video scaler");
    check(sws_scale(scaler.value, source->data, source->linesize, 0, source->height, rgb.value->data, rgb.value->linesize), "Scale thumbnail");
    Frame oriented;
    AVFrame* display = rgb.value;
    if (!transform.identity()) {
      oriented.value->width = width;
      oriented.value->height = height;
      oriented.value->format = AV_PIX_FMT_RGB24;
      check(av_frame_get_buffer(oriented.value, 32), "Allocate oriented thumbnail");
      const int offset_x = (transform.a < 0 ? scaled_width - 1 : 0) + (transform.c < 0 ? scaled_height - 1 : 0);
      const int offset_y = (transform.b < 0 ? scaled_width - 1 : 0) + (transform.d < 0 ? scaled_height - 1 : 0);
      for (int y = 0; y < scaled_height; ++y) {
        task.checkpoint();
        for (int x = 0; x < scaled_width; ++x) {
          const int destination_x = transform.a * x + transform.c * y + offset_x;
          const int destination_y = transform.b * x + transform.d * y + offset_y;
          std::memcpy(oriented.value->data[0] + destination_y * oriented.value->linesize[0] + destination_x * 3,
            rgb.value->data[0] + y * rgb.value->linesize[0] + x * 3, 3);
        }
      }
      display = oriented.value;
    }
    check(avcodec_send_frame(encoder.value, display), "Encode thumbnail");
    Packet png_packet;
    check(avcodec_receive_packet(encoder.value, png_packet.value), "Read encoded thumbnail");
    task.bytes.assign(png_packet.value->data, png_packet.value->data + png_packet.value->size);
    found = true;
    return true;
  });
  if (!found) throw std::runtime_error("No video frame was decoded");
}

struct AudioFormat { const char* name; const char* muxer; const char* encoder; int rate; int channels; int bit_rate; };
constexpr AudioFormat audio_formats[] = {
  { "mp3", "mp3", "libmp3lame", 0, 0, 64000 },
  { "amr", "amr", "libopencore_amrnb", 8000, 1, 12200 },
  { "wma", "asf", "wmav2", 44100, 0, 64000 },
  { "m4a", "ipod", "aac", 0, 0, 64000 },
  { "spx", "ogg", "libspeex", 16000, 0, 24000 },
  { "ogg", "ogg", "libvorbis", 0, 0, 64000 },
  { "wav", "wav", "pcm_s16le", 0, 0, 0 },
  { "flac", "flac", "flac", 0, 0, 0 },
};

void encode_audio(Task& task) {
  if (task.format == "silk") return encode_silk(task);
  const AudioFormat* selected = nullptr;
  for (const auto& format : audio_formats) if (task.format == format.name) selected = &format;
  if (!selected) throw std::runtime_error("Unsupported audio output format: " + task.format);
  const AVCodec* encoder = avcodec_find_encoder_by_name(selected->encoder);
  if (!encoder) throw std::runtime_error(std::string("Audio encoder is not available: ") + selected->encoder);
  Codec codec;
  Output output;
  Resampler resampler;
  codec.value = avcodec_alloc_context3(encoder);
  if (!codec.value) throw std::bad_alloc();
  codec.value->sample_rate = selected->rate ? selected->rate : task.sample_rate;
  codec.value->time_base = { 1, codec.value->sample_rate };
  codec.value->bit_rate = selected->bit_rate;
  const AVSampleFormat* sample_formats = nullptr;
  int format_count = 0;
  check(avcodec_get_supported_config(codec.value, encoder, AV_CODEC_CONFIG_SAMPLE_FORMAT, 0,
    reinterpret_cast<const void**>(&sample_formats), &format_count), "Query audio sample formats");
  codec.value->sample_fmt = sample_formats && format_count ? sample_formats[0] : AV_SAMPLE_FMT_S16;
  const int* sample_rates = nullptr;
  int rate_count = 0;
  check(avcodec_get_supported_config(codec.value, encoder, AV_CODEC_CONFIG_SAMPLE_RATE, 0,
    reinterpret_cast<const void**>(&sample_rates), &rate_count), "Query audio sample rates");
  if (sample_rates && rate_count) {
    int nearest = sample_rates[0];
    for (int i = 1; i < rate_count; ++i)
      if (std::abs(sample_rates[i] - codec.value->sample_rate) < std::abs(nearest - codec.value->sample_rate)) nearest = sample_rates[i];
    codec.value->sample_rate = nearest;
    codec.value->time_base = { 1, nearest };
  }
  int output_channels = selected->channels ? selected->channels : task.channels;
  if (task.format == "mp3" || task.format == "wma" || task.format == "spx") output_channels = std::min(2, output_channels);
  av_channel_layout_default(&codec.value->ch_layout, output_channels);
  check(avformat_alloc_output_context2(&output.value, nullptr, selected->muxer, task.output.c_str()), "Create audio container");
  if (!output.value) throw std::bad_alloc();
  output.value->interrupt_callback = { Task::interrupt, &task };
  if (output.value->oformat->flags & AVFMT_GLOBALHEADER) codec.value->flags |= AV_CODEC_FLAG_GLOBAL_HEADER;
  check(avcodec_open2(codec.value, encoder, nullptr), "Open audio encoder");
  AVStream* stream = avformat_new_stream(output.value, nullptr);
  if (!stream) throw std::bad_alloc();
  stream->time_base = codec.value->time_base;
  check(avcodec_parameters_from_context(stream->codecpar, codec.value), "Write audio codec parameters");
  // FFmpeg's file protocol handles UTF-8 paths on Windows as well as Unix.
  check(avio_open2(&output.value->pb, task.output.c_str(), AVIO_FLAG_WRITE, &output.value->interrupt_callback, nullptr), "Open audio output");
  check(avformat_write_header(output.value, nullptr), "Write audio header");
  AVChannelLayout input_layout{};
  av_channel_layout_default(&input_layout, task.channels);
  const int allocated = swr_alloc_set_opts2(&resampler.value, &codec.value->ch_layout, codec.value->sample_fmt, codec.value->sample_rate,
    &input_layout, AV_SAMPLE_FMT_S16, task.sample_rate, 0, nullptr);
  av_channel_layout_uninit(&input_layout);
  check(allocated, "Allocate encoder resampler");
  check(swr_init(resampler.value), "Initialize encoder resampler");
  Packet packet;
  auto receive = [&]() {
    for (;;) {
      task.checkpoint();
      const int result = avcodec_receive_packet(codec.value, packet.value);
      if (result == AVERROR(EAGAIN) || result == AVERROR_EOF) return;
      check(result, "Read encoded audio packet");
      av_packet_rescale_ts(packet.value, codec.value->time_base, stream->time_base);
      packet.value->stream_index = stream->index;
      const int written = av_interleaved_write_frame(output.value, packet.value);
      av_packet_unref(packet.value);
      check(written, "Write encoded audio packet");
    }
  };
  const int input_samples = static_cast<int>(task.bytes.size() / (task.channels * 2));
  const int frame_size = codec.value->frame_size > 0 ? codec.value->frame_size : 4096;
  AVAudioFifo* allocated_fifo = av_audio_fifo_alloc(codec.value->sample_fmt, codec.value->ch_layout.nb_channels, frame_size);
  if (!allocated_fifo) throw std::bad_alloc();
  std::unique_ptr<AVAudioFifo, decltype(&av_audio_fifo_free)> fifo(allocated_fifo, av_audio_fifo_free);
  int64_t pts = 0;
  auto drain = [&](bool final) {
    while (av_audio_fifo_size(fifo.get()) >= frame_size || (final && av_audio_fifo_size(fifo.get()) > 0)) {
      task.checkpoint();
      const int samples = std::min(frame_size, av_audio_fifo_size(fifo.get()));
      Frame frame;
      frame.value->format = codec.value->sample_fmt;
      frame.value->sample_rate = codec.value->sample_rate;
      check(av_channel_layout_copy(&frame.value->ch_layout, &codec.value->ch_layout), "Copy encoder channel layout");
      frame.value->nb_samples = frame_size;
      check(av_frame_get_buffer(frame.value, 0), "Allocate audio encoding frame");
      if (av_audio_fifo_read(fifo.get(), reinterpret_cast<void**>(frame.value->extended_data), samples) != samples)
        throw std::runtime_error("Read encoder audio FIFO failed");
      frame.value->nb_samples = samples;
      if (samples < frame_size && !(encoder->capabilities & AV_CODEC_CAP_VARIABLE_FRAME_SIZE) &&
          !(encoder->capabilities & AV_CODEC_CAP_SMALL_LAST_FRAME)) {
        check(av_samples_set_silence(frame.value->extended_data, samples, frame_size - samples,
          codec.value->ch_layout.nb_channels, codec.value->sample_fmt), "Pad final audio frame");
        frame.value->nb_samples = frame_size;
      }
      frame.value->pts = pts;
      pts += samples;
      check(avcodec_send_frame(codec.value, frame.value), "Encode audio frame");
      receive();
    }
  };
  int consumed = 0;
  for (;;) {
    task.checkpoint();
    const int amount = std::min(4096, input_samples - consumed);
    const int capacity = std::max(256, swr_get_out_samples(resampler.value, amount));
    Frame converted;
    converted.value->format = codec.value->sample_fmt;
    converted.value->sample_rate = codec.value->sample_rate;
    converted.value->nb_samples = capacity;
    check(av_channel_layout_copy(&converted.value->ch_layout, &codec.value->ch_layout), "Copy resampler channel layout");
    check(av_frame_get_buffer(converted.value, 0), "Allocate resampled PCM frame");
    const uint8_t* pcm = task.bytes.data() + static_cast<size_t>(consumed) * task.channels * 2;
    const int samples = swr_convert(resampler.value, converted.value->extended_data, capacity, amount ? &pcm : nullptr, amount);
    check(samples, "Convert PCM for encoder");
    consumed += amount;
    if (samples && av_audio_fifo_write(fifo.get(), reinterpret_cast<void**>(converted.value->extended_data), samples) != samples)
      throw std::runtime_error("Write encoder audio FIFO failed");
    drain(false);
    if (!amount && !samples) break;
  }
  drain(true);
  check(avcodec_send_frame(codec.value, nullptr), "Flush audio encoder");
  receive();
  check(av_write_trailer(output.value), "Write audio trailer");
  check(avio_closep(&output.value->pb), "Close audio output");
  task.bytes.clear();
}

napi_value string(napi_env env, const std::string& value) {
  napi_value result;
  napi_check(env, napi_create_string_utf8(env, value.data(), value.size(), &result));
  return result;
}
void set_number(napi_env env, napi_value object, const char* key, double value) {
  napi_value number;
  napi_check(env, napi_create_double(env, value, &number));
  napi_check(env, napi_set_named_property(env, object, key, number));
}
void execute(napi_env, void* data) {
  auto& task = *static_cast<Task*>(data);
  task.deadline = std::chrono::steady_clock::now() +
    (task.operation == Operation::thumbnail ? std::chrono::seconds(5) : std::chrono::seconds(120));
  try {
    switch (task.operation) {
      case Operation::probe: probe(task); break;
      case Operation::decode: decode_audio(task); break;
      case Operation::encode: encode_audio(task); break;
      case Operation::thumbnail: thumbnail(task); break;
      case Operation::transcode: {
        SilkInput silk(task);
        if (silk.recognized) {
          task.sample_rate = silk_rate;
          task.channels = 1;
        } else {
          Input input;
          Codec decoder;
          open_input(task, input);
          open_decoder(input, decoder, AVMEDIA_TYPE_AUDIO);
          if (decoder.value->sample_rate <= 0 || decoder.value->ch_layout.nb_channels <= 0)
            throw std::runtime_error("Source audio has invalid sample rate or channels");
          task.sample_rate = decoder.value->sample_rate;
          task.channels = decoder.value->ch_layout.nb_channels;
          if (task.channels > 8) throw std::runtime_error("Source audio has more than 8 channels");
        }
        decode_audio(task);
        encode_audio(task);
        break;
      }
    }
  } catch (const std::exception& error) { task.error = error.what(); }
    catch (...) { task.error = "Unknown FFmpeg native error"; }
}
void complete(napi_env env, napi_status status, void* data) {
  std::unique_ptr<Task> task(static_cast<Task*>(data));
  try {
    if (status != napi_ok && task->error.empty()) task->error = "FFmpeg task was cancelled";
    if (!task->error.empty()) {
      napi_value error;
      napi_check(env, napi_create_error(env, nullptr, string(env, task->error), &error));
      napi_reject_deferred(env, task->deferred, error);
    } else {
      napi_value result;
      if (task->operation == Operation::probe) {
        napi_check(env, napi_create_object(env, &result));
        set_number(env, result, "width", task->width);
        set_number(env, result, "height", task->height);
        set_number(env, result, "duration", task->duration);
        set_number(env, result, "size", task->size);
        napi_check(env, napi_set_named_property(env, result, "format", string(env, task->format)));
      } else if ((task->operation == Operation::encode || task->operation == Operation::transcode)) {
        napi_check(env, napi_get_undefined(env, &result));
      } else {
        napi_check(env, napi_create_buffer_copy(env, task->bytes.size(), task->bytes.data(), nullptr, &result));
      }
      napi_resolve_deferred(env, task->deferred, result);
    }
  } catch (const std::exception& error) {
    napi_value message, exception;
    if (napi_create_string_utf8(env, error.what(), NAPI_AUTO_LENGTH, &message) == napi_ok &&
        napi_create_error(env, nullptr, message, &exception) == napi_ok)
      napi_reject_deferred(env, task->deferred, exception);
  }
  napi_delete_async_work(env, task->work);
}
std::string read_string(napi_env env, napi_value value, const char* label) {
  napi_valuetype type;
  napi_check(env, napi_typeof(env, value, &type));
  if (type != napi_string) throw std::invalid_argument(std::string(label) + " must be a string");
  size_t length = 0;
  napi_check(env, napi_get_value_string_utf8(env, value, nullptr, 0, &length));
  if (length == 0 || length > 32768) throw std::invalid_argument(std::string(label) + " has invalid length");
  std::string result(length, '\0');
  napi_check(env, napi_get_value_string_utf8(env, value, result.data(), length + 1, &length));
  if (result.find('\0') != std::string::npos) throw std::invalid_argument(std::string(label) + " contains a null byte");
  return result;
}
std::string read_path(napi_env env, napi_value value) {
  auto path = read_string(env, value, "Media path");
  const auto colon = path.find(':');
  // Reject URLs/protocols. Drive letters are valid only on Windows.
#ifdef _WIN32
  const bool drive = colon == 1 && ((path[0] >= 'A' && path[0] <= 'Z') || (path[0] >= 'a' && path[0] <= 'z')) &&
    path.size() > 2 && (path[2] == '/' || path[2] == '\\');
  if (colon != std::string::npos && !drive)
#else
  if (colon != std::string::npos)
#endif
    throw std::invalid_argument("Media path must be a local filesystem path");
  return path;
}
int read_integer(napi_env env, napi_value value, int minimum, int maximum, const char* label) {
  double number;
  napi_check(env, napi_get_value_double(env, value, &number));
  if (!std::isfinite(number) || std::floor(number) != number || number < minimum || number > maximum)
    throw std::invalid_argument(std::string(label) + " is out of range");
  return static_cast<int>(number);
}
bool option(napi_env env, napi_value options, const char* key, napi_value* value) {
  bool present;
  napi_check(env, napi_has_named_property(env, options, key, &present));
  if (!present) return false;
  napi_check(env, napi_get_named_property(env, options, key, value));
  napi_valuetype type;
  napi_check(env, napi_typeof(env, *value, &type));
  return type != napi_undefined;
}

template<Operation operation>
napi_value start(napi_env env, napi_callback_info info) {
  try {
    size_t argc = 3;
    napi_value argv[3];
    napi_check(env, napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr));
    constexpr bool encoding = operation == Operation::encode;
    constexpr bool transcoding = operation == Operation::transcode;
    constexpr size_t options_index = encoding || transcoding ? 2 : 1;
    if (argc < (encoding || transcoding ? 3u : 1u)) throw std::invalid_argument("Missing FFmpeg arguments");
    auto task = std::make_unique<Task>();
    task->env = env;
    task->operation = operation;
    if constexpr (encoding) {
      bool buffer = false;
      napi_check(env, napi_is_buffer(env, argv[0], &buffer));
      if (!buffer) throw std::invalid_argument("PCM audio must be a Buffer");
      void* bytes; size_t length;
      napi_check(env, napi_get_buffer_info(env, argv[0], &bytes, &length));
      if (length == 0 || length > max_audio_bytes) throw std::invalid_argument("PCM audio must contain 1 byte to 256 MiB");
      task->bytes.assign(static_cast<uint8_t*>(bytes), static_cast<uint8_t*>(bytes) + length);
    } else task->input = read_path(env, argv[0]);
    if constexpr (encoding || transcoding) task->output = read_path(env, argv[1]);
    if (argc > options_index) {
      napi_valuetype type;
      napi_check(env, napi_typeof(env, argv[options_index], &type));
      if (type != napi_object) throw std::invalid_argument("FFmpeg options must be an object");
      napi_value value;
      if (option(env, argv[options_index], "sampleRate", &value)) task->sample_rate = read_integer(env, value, 8000, 192000, "Sample rate");
      if (option(env, argv[options_index], "channels", &value)) task->channels = read_integer(env, value, 1, 8, "Channels");
      if (option(env, argv[options_index], "format", &value)) task->format = read_string(env, value, "Audio format");
      if (option(env, argv[options_index], "maxWidth", &value)) task->max_width = read_integer(env, value, 1, 8192, "Maximum width");
      if (option(env, argv[options_index], "maxHeight", &value)) task->max_height = read_integer(env, value, 1, 8192, "Maximum height");
      if (option(env, argv[options_index], "time", &value)) {
        napi_check(env, napi_get_value_double(env, value, &task->time));
        if (!std::isfinite(task->time) || task->time < 0 || task->time > 86400)
          throw std::invalid_argument("Thumbnail time must be from 0 to 86400 seconds");
      }
    }
    if constexpr (encoding || transcoding) {
      if (task->format.empty()) throw std::invalid_argument("An audio output format is required");
      if constexpr (encoding) if (task->bytes.size() % (task->channels * 2))
        throw std::invalid_argument("PCM byte length does not align to its channels");
    }
    napi_value promise;
    napi_check(env, napi_create_promise(env, &task->deferred, &promise));
    napi_check(env, napi_create_async_work(env, nullptr, string(env, "LuckyLillia.FFmpeg"), execute, complete, task.get(), &task->work));
    const auto queued = napi_queue_async_work(env, task->work);
    if (queued != napi_ok) { napi_delete_async_work(env, task->work); napi_check(env, queued); }
    task.release();
    return promise;
  } catch (const std::exception& error) {
    napi_throw_error(env, nullptr, error.what());
    return nullptr;
  }
}
napi_value version(napi_env env, napi_callback_info) {
  try { return string(env, av_version_info()); }
  catch (const std::exception& error) { napi_throw_error(env, nullptr, error.what()); return nullptr; }
}
napi_value silk_version(napi_env env, napi_callback_info) {
  try { return string(env, SKP_Silk_SDK_get_version()); }
  catch (const std::exception& error) { napi_throw_error(env, nullptr, error.what()); return nullptr; }
}
napi_value initialize(napi_env env, napi_value exports) {
  const napi_property_descriptor properties[] = {
    { "probe", nullptr, start<Operation::probe>, nullptr, nullptr, nullptr, napi_default, nullptr },
    { "decodeAudio", nullptr, start<Operation::decode>, nullptr, nullptr, nullptr, napi_default, nullptr },
    { "encodeAudio", nullptr, start<Operation::encode>, nullptr, nullptr, nullptr, napi_default, nullptr },
    { "transcodeAudio", nullptr, start<Operation::transcode>, nullptr, nullptr, nullptr, napi_default, nullptr },
    { "thumbnail", nullptr, start<Operation::thumbnail>, nullptr, nullptr, nullptr, napi_default, nullptr },
    { "version", nullptr, version, nullptr, nullptr, nullptr, napi_default, nullptr },
    { "silkVersion", nullptr, silk_version, nullptr, nullptr, nullptr, napi_default, nullptr },
  };
  if (napi_define_properties(env, exports, sizeof(properties) / sizeof(properties[0]), properties) != napi_ok) return nullptr;
  return exports;
}
} // namespace

NAPI_MODULE(NODE_GYP_MODULE_NAME, initialize)

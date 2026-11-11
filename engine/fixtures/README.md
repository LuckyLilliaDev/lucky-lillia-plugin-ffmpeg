These fixtures belong to the plugin repository's `engine/` directory. Run `node engine/smoke.mjs engine/artifacts/<target>/LuckyLillia.FFmpeg.node` from the plugin root, or run `node smoke.mjs artifacts/<target>/LuckyLillia.FFmpeg.node` from `engine/`. Fixtures are development assets and are not included in the npm plugin package.

`video.mp4` is a synthetic red 32×24 video, five frames long, generated only as a decoding fixture:

```sh
ffmpeg -f lavfi -i color=c=red:s=32x24:r=5:d=1 -c:v mpeg4 -q:v 4 -an -map_metadata -1 video.mp4
```

The command is only needed to regenerate this fixture. Native smoke tests use the checked-in file and do not execute FFmpeg. Audio fixtures are generated as PCM buffers by `smoke.mjs`.

The SILK interoperability fixtures are checked-in test data, with no WASM dependency at runtime or during tests:

- interop-wasm-24k.silk and silk-wasm.silk were generated independently by silk-wasm 3.7.1. Their original JSON sidecars preserve its encoded and decoded hashes. The test oracle in interop-wasm-sdk.json comes from the unchanged upstream SDK Decoder.c: the old WASM wrapper fails to update its buffered packet lengths after the first two packets, so its decoded PCM and reported duration cannot serve as correct reference output. Both original evidence and the separately verified SDK hashes are retained.
- interop-sdk-standard-40.silk, interop-sdk-standard-60.silk, and interop-sdk-standard-100.silk were generated with the unchanged upstream SILK SDK Encoder.c. interop-sdk-packets.json records the pinned source, parameters, and exact PCM hashes from its independent Decoder.c.
- Standard SILK starts with the nine bytes #!SILK_V3, with no newline; Tencent framing adds an initial byte 0x02. Standard fixtures include a terminal length of -1. The smoke checks both headers, varying packet durations, malformed framing, resampling, partial final frames, and concurrent calls.

`orientation.mp4` uses the same 32×24 five-frame encoding, with red/green/blue/white quadrants (top-left/top-right/bottom-left/bottom-right). `image.jpg` is its first frame. `rotate90.mp4` was generated from it by FFmpeg's `-display_rotation 90 -c copy`; the video pixels stay unchanged, while the container has a 90-degree display matrix. The smoke tests verify rotated dimensions and actual quadrant colors, and additionally replace the fixture's track display matrix to check 180/270-degree rotation and reflection. They also probe real PNG/JPEG files and reject an oversized PNG header with a valid recalculated IHDR checksum.

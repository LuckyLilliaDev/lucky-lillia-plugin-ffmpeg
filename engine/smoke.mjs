import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile, rm, truncate } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { inflateSync, crc32 } from 'node:zlib'

function pngPixels(png) {
  const width = png.readUInt32BE(16), height = png.readUInt32BE(20)
  assert.equal(png[24], 8)
  assert.equal(png[25], 2, 'thumbnail is RGB PNG')
  assert.equal(png[28], 0)
  const chunks = []
  for (let offset = 8; offset + 12 <= png.length;) {
    const length = png.readUInt32BE(offset)
    if (png.toString('ascii', offset + 4, offset + 8) === 'IDAT') chunks.push(png.subarray(offset + 8, offset + 8 + length))
    offset += length + 12
  }
  const raw = inflateSync(Buffer.concat(chunks)), stride = width * 3
  assert.equal(raw.length, (stride + 1) * height)
  const pixels = Buffer.alloc(stride * height)
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)]
    for (let x = 0; x < stride; x++) {
      const left = x >= 3 ? pixels[y * stride + x - 3] : 0
      const up = y ? pixels[(y - 1) * stride + x] : 0
      const upperLeft = y && x >= 3 ? pixels[(y - 1) * stride + x - 3] : 0
      let predict = 0
      if (filter === 1) predict = left
      else if (filter === 2) predict = up
      else if (filter === 3) predict = Math.floor((left + up) / 2)
      else if (filter === 4) {
        const p = left + up - upperLeft
        const a = Math.abs(p - left), b = Math.abs(p - up), c = Math.abs(p - upperLeft)
        predict = a <= b && a <= c ? left : b <= c ? up : upperLeft
      } else assert.equal(filter, 0)
      pixels[y * stride + x] = (raw[y * (stride + 1) + x + 1] + predict) & 255
    }
  }
  const colors = [[0.25, 0.25], [0.75, 0.25], [0.25, 0.75], [0.75, 0.75]].map(([x, y]) => {
    const offset = (Math.floor(y * height) * width + Math.floor(x * width)) * 3
    const [r, g, b] = pixels.subarray(offset, offset + 3)
    if (r > 180 && g < 80 && b < 80) return 'red'
    if (g > 180 && r < 80 && b < 80) return 'green'
    if (b > 180 && r < 80 && g < 80) return 'blue'
    if (r > 180 && g > 180 && b > 180) return 'white'
    assert.fail(`Unexpected fixture pixel: ${r},${g},${b}`)
  })
  return { width, height, colors }
}

const require = createRequire(import.meta.url)
const native = require(path.resolve(process.argv[2] || path.join(import.meta.dirname, 'artifacts/win-x64/LuckyLillia.FFmpeg.node')))
const formats = process.argv.includes('--limited') ? ['wav'] : ['mp3', 'amr', 'wma', 'm4a', 'spx', 'ogg', 'wav', 'flac', 'silk']
const directory = await mkdtemp(path.join(tmpdir(), 'llbot-ffmpeg-测试-'))
const pcm = Buffer.alloc(24000 * 2)
for (let i = 0; i < 24000; i++) pcm.writeInt16LE(Math.round(Math.sin(i * 2 * Math.PI * 440 / 24000) * 8000), i * 2)
const results = []
try {
  assert.equal(typeof native.version(), 'string')
  assert.equal(typeof native.silkVersion(), 'string')
  assert.ok(native.silkVersion().length > 0)
  for (const format of formats) {
    const destination = path.join(directory, `音频.${format}`)
    await native.encodeAudio(pcm, destination, { format, sampleRate: 24000, channels: 1 })
    const info = await native.probe(destination)
    assert.ok(info.duration > 0.85 && info.duration < 1.3, `${format} duration: ${info.duration}`)
    assert.ok(info.size > 0)
    const decoded = await native.decodeAudio(destination, { sampleRate: 24000, channels: 1 })
    assert.ok(decoded.length > 40000 && decoded.length < 65000, `${format} decoded bytes: ${decoded.length}`)
    if (format === 'wav' || format === 'flac') assert.deepEqual(decoded, pcm)
    results.push({ format, bytes: info.size, duration: info.duration, decodedBytes: decoded.length })
  }
  const stereo = Buffer.alloc(44100 * 4)
  for (let i = 0; i < 44100; i++) {
    stereo.writeInt16LE(Math.round(Math.sin(i * 2 * Math.PI * 440 / 44100) * 8000), i * 4)
    stereo.writeInt16LE(Math.round(Math.sin(i * 2 * Math.PI * 880 / 44100) * 8000), i * 4 + 2)
  }
  const source = path.join(directory, '立体声.wav')
  const transcoded = path.join(directory, '保持采样率.wav')
  await native.encodeAudio(stereo, source, { format: 'wav', sampleRate: 44100, channels: 2 })
  await native.transcodeAudio(source, transcoded, { format: 'wav' })
  assert.deepEqual(await native.decodeAudio(transcoded, { sampleRate: 44100, channels: 2 }), stereo)
  const wave = await readFile(transcoded)
  const fmt = wave.indexOf(Buffer.from('fmt '))
  assert.ok(fmt >= 12)
  assert.equal(wave.readUInt16LE(fmt + 10), 2)
  assert.equal(wave.readUInt32LE(fmt + 12), 44100)
  const silkPath = path.join(directory, '带任意扩展名的语音.bin')
  await native.encodeAudio(pcm, silkPath, { format: 'silk', sampleRate: 24000, channels: 1 })
  const silk = await readFile(silkPath)
  assert.deepEqual(silk.subarray(0, 10), Buffer.from('\x02#!SILK_V3'))
  assert.deepEqual(await native.probe(silkPath), { width: 0, height: 0, duration: 1, size: silk.length, format: 'silk' })
  const silkPcm = await native.decodeAudio(silkPath)
  assert.equal(silkPcm.length, pcm.length)
  let packetCount = 0
  for (let offset = 10; offset < silk.length;) {
    const length = silk.readUInt16LE(offset)
    assert.ok(length >= 4 && length <= 1024 && offset + 2 + length <= silk.length)
    offset += length + 2
    packetCount++
  }
  assert.equal(packetCount, 50)
  const standard = path.join(directory, '标准SILK.silk')
  await writeFile(standard, Buffer.concat([silk.subarray(1), Buffer.from([255, 255])]))
  assert.equal((await native.probe(standard)).duration, 1)
  assert.deepEqual(await native.decodeAudio(standard), silkPcm)
  const upsampled = await native.decodeAudio(standard, { sampleRate: 48000, channels: 2 })
  assert.equal(upsampled.length, 48000 * 4)
  const silkStereo = path.join(directory, '立体声转单声道.silk')
  await native.transcodeAudio(source, silkStereo, { format: 'silk' })
  assert.equal((await native.probe(silkStereo)).duration, 1)
  const silkLossless = path.join(directory, '语音转FLAC.flac')
  await native.transcodeAudio(silkStereo, silkLossless, { format: 'flac' })
  assert.deepEqual(await native.decodeAudio(silkLossless), await native.decodeAudio(silkStereo))
  for (const samples of [1, 479, 480, 481, 487]) {
    const tail = path.join(directory, '不完整帧-' + samples + '.silk')
    await native.encodeAudio(pcm.subarray(0, samples * 2), tail, { format: 'silk', sampleRate: 24000, channels: 1 })
    const frames = Math.ceil(samples / 480)
    assert.equal((await native.probe(tail)).duration, frames / 50)
    assert.equal((await native.decodeAudio(tail)).length, frames * 480 * 2)
  }
  for (const sampleRate of [8000, 12000, 16000, 44100, 48000, 192000]) {
    for (const samples of [1, sampleRate / 50 + 1]) {
      const channels = sampleRate === 192000 ? 8 : 2
      const tail = path.join(directory, '重采样尾帧-' + sampleRate + '-' + samples + '.silk')
      await native.encodeAudio(Buffer.alloc(samples * channels * 2), tail, { format: 'silk', sampleRate, channels })
      const frames = Math.ceil(samples * 50 / sampleRate)
      assert.equal((await native.probe(tail)).duration, frames / 50)
      assert.equal((await native.decodeAudio(tail)).length, frames * 480 * 2)
    }
  }
  // Bitstreams came from independent silk-wasm 3.7.1. The unchanged upstream
  // SDK decoder supplies the PCM oracle; see interop-wasm-sdk.json for the
  // legacy WASM wrapper's packet-buffer bug and preserved original hashes.
  // This smoke has no WASM/npm dependency and runs on each target's Node.
  const referenceFile = fileURLToPath(new URL('./fixtures/interop-wasm-24k.silk', import.meta.url))
  const wasmFixtures = JSON.parse(await readFile(new URL('./fixtures/interop-wasm-sdk.json', import.meta.url), 'utf8'))
  const reference = wasmFixtures.records[0]
  const referencePcm = await native.decodeAudio(referenceFile)
  assert.equal(referencePcm.length, reference.decodedPcmBytes)
  assert.equal(createHash('sha256').update(referencePcm).digest('hex'), reference.decodedPcmSha256)
  assert.equal((await native.probe(referenceFile)).duration, reference.decodedPcmBytes / 2 / 24000)
  for (const fixture of wasmFixtures.records) {
    const filename = fileURLToPath(new URL('./fixtures/' + fixture.file, import.meta.url))
    assert.equal(createHash('sha256').update(await readFile(filename)).digest('hex'), fixture.encodedSha256)
    const decoded = await native.decodeAudio(filename)
    assert.equal(decoded.length, fixture.decodedPcmBytes)
    assert.equal(createHash('sha256').update(decoded).digest('hex'), fixture.decodedPcmSha256)
  }
  const packetFixtures = JSON.parse(await readFile(new URL('./fixtures/interop-sdk-packets.json', import.meta.url), 'utf8'))
  const mixedPackets = [Buffer.from('#!SILK_V3')]
  let mixedDuration = 0
  for (const fixture of packetFixtures.records) {
    const filename = fileURLToPath(new URL('./fixtures/' + fixture.file, import.meta.url))
    const encoded = await readFile(filename)
    assert.equal(createHash('sha256').update(encoded).digest('hex'), fixture.encodedSha256)
    const decoded = await native.decodeAudio(filename)
    assert.equal(decoded.length, fixture.decodedPcmBytes)
    assert.equal(createHash('sha256').update(decoded).digest('hex'), fixture.decodedPcmSha256)
    assert.equal((await native.probe(filename)).duration, fixture.durationSeconds)
    mixedPackets.push(encoded.subarray(9, encoded.length - 2))
    mixedDuration += fixture.decodedPcmBytes / 2 / 24000
  }
  mixedPackets.push(Buffer.from([255, 255]))
  const mixedPacketFile = path.join(directory, '混合帧数.silk')
  await writeFile(mixedPacketFile, Buffer.concat(mixedPackets))
  assert.ok(Math.abs((await native.probe(mixedPacketFile)).duration - mixedDuration) < 0.000001)
  assert.equal((await native.decodeAudio(mixedPacketFile)).length, Math.round(mixedDuration * 24000) * 2)
  const invalidSilk = [
    silk.subarray(0, silk.length - 1),
    Buffer.concat([silk.subarray(0, 10), Buffer.from([1])]),
    Buffer.concat([silk.subarray(0, 10), Buffer.from([0, 0])]),
    Buffer.concat([silk.subarray(0, 10), Buffer.from([255, 127])]),
    Buffer.concat([silk.subarray(0, 10), Buffer.from([1, 0, 255])]),
    Buffer.concat([silk.subarray(0, 10), Buffer.from([4, 0, 255, 255, 255, 255])]),
    Buffer.concat([silk, Buffer.from([255, 255, 0])]),
    silk.subarray(0, 10),
  ]
  for (let index = 0; index < invalidSilk.length; index++) {
    const filename = path.join(directory, '无效SILK-' + index + '.silk')
    await writeFile(filename, invalidSilk[index])
    await assert.rejects(native.probe(filename))
    await assert.rejects(native.decodeAudio(filename))
  }
  const oversizedSilk = path.join(directory, '超大语音.silk')
  await writeFile(oversizedSilk, silk)
  await truncate(oversizedSilk, 256 * 1024 * 1024 + 1)
  await assert.rejects(native.probe(oversizedSilk))
  await assert.rejects(native.decodeAudio(oversizedSilk))
  const silkConcurrent = await Promise.all(Array.from({ length: 8 }, () => native.decodeAudio(referenceFile)))
  assert.ok(silkConcurrent.every(bytes => bytes.equals(referencePcm)))
  const video = fileURLToPath(new URL('./fixtures/video.mp4', import.meta.url))
  const info = await native.probe(video)
  assert.equal(info.width, 32)
  assert.equal(info.height, 24)
  assert.ok(info.duration >= 0.9 && info.duration <= 1.1)
  const thumb = await native.thumbnail(video, { maxWidth: 16, maxHeight: 16 })
  assert.deepEqual(thumb.subarray(0, 8), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  assert.equal(thumb.readUInt32BE(16), 16)
  assert.equal(thumb.readUInt32BE(20), 12)
  const sought = await native.thumbnail(video, { time: 0.4 })
  assert.ok(sought.length > 50)
  const still = path.join(directory, '真实图片.png')
  await writeFile(still, thumb)
  const pngInfo = await native.probe(still)
  assert.equal(pngInfo.width, 16)
  assert.equal(pngInfo.height, 12)
  assert.equal(pngInfo.size, thumb.length)
  const oversized = Buffer.from(thumb)
  oversized.writeUInt32BE(9000, 16)
  oversized.writeUInt32BE(9000, 20)
  oversized.writeUInt32BE(crc32(oversized.subarray(12, 29)), 29)
  const oversizedPath = path.join(directory, '超大尺寸.png')
  await writeFile(oversizedPath, oversized)
  await assert.rejects(native.probe(oversizedPath))
  await assert.rejects(native.thumbnail(oversizedPath))
  const jpeg = fileURLToPath(new URL('./fixtures/image.jpg', import.meta.url))
  const jpegInfo = await native.probe(jpeg)
  assert.equal(jpegInfo.width, 32)
  assert.equal(jpegInfo.height, 24)
  assert.equal(jpegInfo.size, (await readFile(jpeg)).length)
  const orientation = fileURLToPath(new URL('./fixtures/orientation.mp4', import.meta.url))
  assert.deepEqual(pngPixels(await native.thumbnail(orientation)).colors, ['red', 'green', 'blue', 'white'])
  const rotated90 = fileURLToPath(new URL('./fixtures/rotate90.mp4', import.meta.url))
  assert.deepEqual(pngPixels(await native.thumbnail(rotated90)), { width: 24, height: 32, colors: ['green', 'white', 'red', 'blue'] })
  const rotations = [
    { name: 'rotate180', matrix: [-65536, 0, 0, -65536], width: 32, height: 24, colors: ['white', 'blue', 'green', 'red'] },
    { name: 'rotate270', matrix: [0, 65536, -65536, 0], width: 24, height: 32, colors: ['blue', 'red', 'white', 'green'] },
    { name: 'reflect', matrix: [-65536, 0, 0, 65536], width: 32, height: 24, colors: ['green', 'red', 'white', 'blue'] },
  ]
  for (const variant of rotations) {
    const bytes = await readFile(orientation)
    const tkhd = bytes.indexOf(Buffer.from('tkhd'))
    assert.ok(tkhd > 0)
    const offset = tkhd + (bytes[tkhd + 4] === 1 ? 56 : 44)
    for (const [index, value] of [[0, variant.matrix[0]], [1, variant.matrix[1]], [3, variant.matrix[2]], [4, variant.matrix[3]]])
      bytes.writeInt32BE(value, offset + index * 4)
    const filename = path.join(directory, `${variant.name}.mp4`)
    await writeFile(filename, bytes)
    assert.deepEqual(pngPixels(await native.thumbnail(filename)), { width: variant.width, height: variant.height, colors: variant.colors })
  }
  const concurrent = await Promise.all(Array.from({ length: 8 }, () => native.decodeAudio(source)))
  assert.ok(concurrent.every(value => value.length === pcm.length))
  const corrupt = path.join(directory, '损坏.wav')
  await writeFile(corrupt, 'not media')
  await assert.rejects(native.probe(corrupt))
  await assert.rejects(native.decodeAudio(corrupt))
  await assert.rejects(native.thumbnail(source))
  await assert.rejects(native.decodeAudio(path.join(directory, 'missing.wav')))
  await assert.rejects(native.decodeAudio(directory))
  assert.throws(() => native.decodeAudio(source, { channels: 0 }))
  assert.throws(() => native.decodeAudio('https://example.invalid/audio.wav'))
  assert.throws(() => native.encodeAudio(Buffer.alloc(3), path.join(directory, 'bad.wav'), { format: 'wav' }))
  await assert.rejects(native.encodeAudio(pcm, path.join(directory, 'bad.bin'), { format: 'invalid' }))
  console.log(JSON.stringify({ version: native.version(), silkVersion: native.silkVersion(), formats: results, stereoPreserved: true, silkInteroperability: true, silkFramingAndTail: true, silkMultiFramePackets: [40, 60, 100, 'mixed'], video: info, concurrentJobs: concurrent.length, invalidInputsRejected: true, stillImageProbe: true, displayTransforms: [90, 180, 270, 'horizontal reflection'] }, null, 2))
} finally {
  await rm(directory, { recursive: true, force: true })
}

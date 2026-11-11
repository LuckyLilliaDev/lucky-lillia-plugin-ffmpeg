import assert from 'node:assert/strict'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Worker } from 'node:worker_threads'

const require = createRequire(import.meta.url)
const sourceRoot = path.resolve(process.argv[2] || path.join(import.meta.dirname, '../native'))
const loaderPath = path.join(sourceRoot, 'loader.cjs')
const loader = require(loaderPath)
assert.equal(loader.inspectBundle(sourceRoot, { allTargets: true }).length, 6)
const [verified] = loader.inspectBundle(sourceRoot)
const scratch = mkdtempSync(path.join(tmpdir(), 'llbot-ffmpeg-loader-'))
const installed = path.join(scratch, 'installed')
const targetDir = path.join(installed, verified.target)
mkdirSync(targetDir, { recursive: true })
const original = path.join(targetDir, verified.metadata.filename)
copyFileSync(verified.file, original)
writeFileSync(path.join(targetDir, 'build.json'), JSON.stringify(verified.metadata))

const native = loader.loadNative(installed, { cacheDir: path.join(scratch, 'cache') })
const loaded = Object.keys(require.cache).find(file => file.startsWith(scratch) && file.endsWith('.node'))
assert.ok(loaded)
assert.equal(path.basename(loaded), 'LuckyLillia.FFmpeg.' + verified.metadata.sha256 + '.node')
assert.notEqual(loaded, original)
renameSync(original, original + '.old')
copyFileSync(original + '.old', original)
const pcm = Buffer.alloc(48000)
for (let i = 0; i < 24000; i++) pcm.writeInt16LE(Math.round(Math.sin(i * 2 * Math.PI * 440 / 24000) * 8000), i * 2)
const wave = path.join(scratch, '原文件替换后.wav')
await native.encodeAudio(pcm, wave, { format: 'wav', sampleRate: 24000, channels: 1 })
assert.deepEqual(await native.decodeAudio(wave, { sampleRate: 24000, channels: 1 }), pcm)

const corruptDir = path.join(scratch, 'corrupt-cache', verified.target)
mkdirSync(corruptDir, { recursive: true })
writeFileSync(path.join(corruptDir, path.basename(loaded)), 'corrupt')
assert.throws(() => loader.loadNative(installed, { cacheDir: path.dirname(corruptDir) }), /缓存已损坏/)

const workerCode = `
const { parentPort, workerData } = require('node:worker_threads')
const loader = require(workerData.loaderPath)
const native = loader.loadNative(workerData.installed, { cacheDir: workerData.cache })
native.probe(workerData.wave).then(info => parentPort.postMessage({
  info,
  loaded: Object.keys(require.cache).find(file => file.startsWith(workerData.cache) && file.endsWith('.node')),
}), error => { throw error })
`
const concurrent = await Promise.all(Array.from({ length: 4 }, () => new Promise((resolve, reject) => {
  const worker = new Worker(workerCode, { eval: true, workerData: {
    loaderPath, installed, wave, cache: path.join(scratch, 'concurrent-cache'),
  } })
  let result
  worker.once('message', message => { result = message })
  worker.once('error', reject)
  worker.once('exit', code => code ? reject(new Error('FFmpeg worker exited ' + code)) : resolve(result))
})))
assert.equal(new Set(concurrent.map(result => result.loaded)).size, 1)
assert.ok(concurrent.every(result => result.info.duration === 1))
assert.deepEqual(readFileSync(original), readFileSync(original + '.old'))
console.log(JSON.stringify({ target: verified.target, passed: true,
  checks: ['hashed temporary load', 'original replacement while loaded', 'native audio round-trip', 'corrupt cache rejection', 'concurrent first load'], scratch }, null, 2))
// Retain loaded native files until this process and its workers have exited.

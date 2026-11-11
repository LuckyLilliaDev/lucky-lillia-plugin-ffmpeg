import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire, registerHooks } from 'node:module'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { pathToFileURL } from 'node:url'

let root = path.resolve(import.meta.dirname, '..')
let host = path.resolve(root, '../../LuckyLillia.Bot')
for (let index = 2; index < process.argv.length; index++) {
  const option = process.argv[index]
  if (!['--host', '--plugin'].includes(option) || !process.argv[index + 1]) {
    throw new Error('Usage: node test/service.mjs [--host BOT_CHECKOUT] [--plugin PLUGIN_DIRECTORY]')
  }
  const value = path.resolve(process.argv[++index])
  if (option === '--host') host = value
  else root = value
}

// Only this test maps the unpublished SDK to a local host. The distributed
// plugin imports the host-provided SDK normally and bundles no host runtime.
const hostRequire = createRequire(path.join(host, 'package.json'))
const sdkUrl = pathToFileURL(hostRequire.resolve('@luckylillia/plugin-sdk')).href
const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === '@luckylillia/plugin-sdk') return { url: sdkUrl, shortCircuit: true }
    return nextResolve(specifier, context)
  },
})
const scratch = mkdtempSync(path.join(tmpdir(), 'lucky-lillia-ffmpeg-service-'))
const contexts = []

async function waitFor(check, description) {
  const deadline = Date.now() + 5000
  while (!check()) {
    assert.ok(Date.now() < deadline, 'Timed out waiting for ' + description)
    await delay(5)
  }
}

try {
  const entry = path.join(root, 'lib/index.js')
  if (!existsSync(entry)) execFileSync(process.execPath, [path.join(root, 'scripts/build.mjs')], { stdio: 'inherit' })
  const { Context } = await import(sdkUrl)
  const plugin = await import(pathToFileURL(entry).href)
  const require = createRequire(import.meta.url)
  const loader = require(path.join(root, 'native/loader.cjs'))
  const [verified] = loader.inspectBundle(path.join(root, 'native'))
  const context = new Context()
  contexts.push(context)
  let mounts = 0
  let cleanups = 0
  let unrelatedMounts = 0
  let activeScope
  await context.plugin(() => { unrelatedMounts++ })
  const consumer = context.inject(['ffmpeg'], scope => {
    mounts++
    activeScope = scope
    scope.effect(() => () => {
      cleanups++
      activeScope = undefined
    })
  })
  await consumer.await()
  assert.equal(mounts, 0, 'Optional consumer must wait without FFmpeg')
  assert.equal(context.get('ffmpeg'), undefined)
  assert.equal(unrelatedMounts, 1, 'Other plugins must start without FFmpeg')

  const provider = context.plugin(plugin)
  await provider
  await waitFor(() => activeScope, 'the optional consumer to mount')
  await consumer.await()
  assert.equal(mounts, 1)
  assert.equal(activeScope.ffmpeg.version(), verified.metadata.ffmpegVersion)
  assert.equal(context.ffmpeg.version(), verified.metadata.ffmpegVersion)
  assert.equal(typeof activeScope.ffmpeg.silkVersion(), 'string')

  const sampleRate = 24000
  const samples = 3000
  const pcm = Buffer.alloc(samples * 2)
  for (let index = 0; index < samples; index++) {
    pcm.writeInt16LE(Math.round(9000 * Math.sin(index * 2 * Math.PI * 440 / sampleRate)), index * 2)
  }
  const wave = path.join(scratch, '通过注入服务编码.wav')
  // Access the real service through consumer/extended Context shadows, rather
  // than calling the raw addon or service instance outside Cordis.
  await activeScope.ffmpeg.encodeAudio(pcm, wave, { format: 'wav', sampleRate, channels: 1 })
  const scoped = activeScope.extend()
  const info = await scoped.ffmpeg.probe(wave)
  assert.equal(info.format, 'wav')
  assert.ok(Math.abs(info.duration - samples / sampleRate) < 0.000001)
  assert.ok(info.size > pcm.length)
  assert.deepEqual(await scoped.ffmpeg.decodeAudio(wave, { sampleRate, channels: 1 }), pcm)
  const silk = path.join(scratch, '通过注入服务编码.silk')
  await scoped.ffmpeg.transcodeAudio(wave, silk, { format: 'silk' })
  assert.equal((await scoped.ffmpeg.probe(silk)).format, 'silk')
  const silkPcm = await scoped.ffmpeg.decodeAudio(silk, { sampleRate, channels: 1 })
  assert.ok(silkPcm.length >= pcm.length && silkPcm.length < pcm.length + sampleRate / 50 * 2)

  await provider.dispose()
  await consumer.await()
  assert.equal(activeScope, undefined, 'Disabling the provider must unmount its optional consumer')
  assert.equal(cleanups, 1)
  assert.equal(context.get('ffmpeg'), undefined, 'Disabled provider must not leave a service behind')
  assert.equal(mounts, 1)
  assert.equal(unrelatedMounts, 1)

  const enabledAgain = context.plugin(plugin)
  await enabledAgain
  await waitFor(() => activeScope, 'the optional consumer to remount')
  await consumer.await()
  assert.equal(mounts, 2)
  const lossless = path.join(scratch, '重新启用后.flac')
  await activeScope.ffmpeg.transcodeAudio(wave, lossless, { format: 'flac' })
  assert.deepEqual(await activeScope.extend().ffmpeg.decodeAudio(lossless, { sampleRate, channels: 1 }), pcm)
  assert.equal(activeScope.ffmpeg.version(), verified.metadata.ffmpegVersion)
  await enabledAgain.dispose()
  await consumer.await()
  assert.equal(cleanups, 2)
  assert.equal(context.get('ffmpeg'), undefined)
  assert.equal(unrelatedMounts, 1, 'Provider toggles must not restart unrelated plugins')

  const reloadRoot = path.join(scratch, 'loader-reload')
  const reloadTarget = path.join(reloadRoot, 'native', verified.target)
  mkdirSync(path.join(reloadRoot, 'lib'), { recursive: true })
  mkdirSync(reloadTarget, { recursive: true })
  writeFileSync(path.join(reloadRoot, 'package.json'), JSON.stringify({ type: 'module' }))
  copyFileSync(entry, path.join(reloadRoot, 'lib/index.js'))
  copyFileSync(verified.file, path.join(reloadTarget, verified.metadata.filename))
  writeFileSync(path.join(reloadTarget, 'build.json'), JSON.stringify(verified.metadata))
  const loaderSource = readFileSync(path.join(root, 'native/loader.cjs'), 'utf8')
  const replacePrivateLoader = version => writeFileSync(path.join(reloadRoot, 'native/loader.cjs'),
    loaderSource + '\nconst originalLoad = module.exports.loadNative;\nmodule.exports.loadNative = (...args) => {\n' +
    'const wrapper = Object.create(originalLoad(...args));\nObject.defineProperty(wrapper, "version", { value: () => ' +
    JSON.stringify(version) + ' });\nreturn wrapper;\n};\n')
  const reloadContext = new Context()
  contexts.push(reloadContext)
  const reloadedPlugin = await import(pathToFileURL(path.join(reloadRoot, 'lib/index.js')).href)
  for (const version of ['private-loader-v1', 'private-loader-v2']) {
    replacePrivateLoader(version)
    const mounted = reloadContext.plugin(reloadedPlugin)
    await mounted
    assert.equal(reloadContext.ffmpeg.version(), version, 'Package reload must read its updated private JS loader')
    await mounted.dispose()
  }

  const rejectedFixtures = []
  for (const failure of ['missing-binary', 'corrupt-hash']) {
    const fixture = path.join(scratch, failure)
    const nativeDirectory = path.join(fixture, 'native')
    const targetDirectory = path.join(nativeDirectory, verified.target)
    mkdirSync(path.join(fixture, 'lib'), { recursive: true })
    mkdirSync(targetDirectory, { recursive: true })
    writeFileSync(path.join(fixture, 'package.json'), JSON.stringify({ type: 'module' }))
    copyFileSync(entry, path.join(fixture, 'lib/index.js'))
    copyFileSync(path.join(root, 'native/loader.cjs'), path.join(nativeDirectory, 'loader.cjs'))
    const metadata = { ...verified.metadata }
    if (failure === 'corrupt-hash') {
      copyFileSync(verified.file, path.join(targetDirectory, metadata.filename))
      metadata.sha256 = '0'.repeat(64)
    }
    writeFileSync(path.join(targetDirectory, 'build.json'), JSON.stringify(metadata))
    const broken = await import(pathToFileURL(path.join(fixture, 'lib/index.js')).href)
    const isolated = new Context()
    contexts.push(isolated)
    let failedConsumerMounts = 0
    const pending = isolated.inject(['ffmpeg'], () => { failedConsumerMounts++ })
    const failed = isolated.plugin(broken)
    await assert.rejects(failed.await(), error => failure === 'missing-binary'
      ? error.code === 'ENOENT' && error.message.includes(metadata.filename)
      : /FFmpeg 原生模块校验失败/.test(error.message))
    await pending.await()
    assert.equal(isolated.get('ffmpeg'), undefined, failure + ' must not publish FFmpeg')
    assert.equal(failedConsumerMounts, 0, failure + ' must not activate optional consumers')
    assert.ok(!Object.keys(require.cache).some(file => file.startsWith(fixture + path.sep) && file.endsWith('.node')))
    await failed.dispose()
    rejectedFixtures.push(failure)
  }
  // Reinspect the distributed engine after failure tests; only isolated fixture
  // files were modified and the original bundle still matches its manifest.
  assert.equal(loader.inspectBundle(path.join(root, 'native'))[0].metadata.sha256, verified.metadata.sha256)
  assert.equal(readFileSync(wave).subarray(0, 4).toString(), 'RIFF')
  console.log(JSON.stringify({ target: verified.target, passed: true, mounts, cleanups, unrelatedMounts,
    checks: ['real shared SDK', 'optional service injection', 'scoped native PCM roundtrip',
      'disable cleanup', 'reenable and lossless transcode', 'private loader update', ...rejectedFixtures] }, null, 2))
} finally {
  try {
    await Promise.all(contexts.reverse().map(context => context.fiber.dispose()))
  } finally {
    hooks.deregister()
    // This unique directory contains only media and rejected (never loaded)
    // fixture binaries; loaded native cache files live outside it.
    rmSync(scratch, { recursive: true, force: true })
  }
}

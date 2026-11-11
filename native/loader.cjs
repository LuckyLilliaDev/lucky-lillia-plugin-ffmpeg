'use strict'

const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const { createHash, randomUUID } = require('node:crypto')

const filename = 'LuckyLillia.FFmpeg.node'
const targets = Object.freeze([
  'win-x64', 'macos-arm64',
  'linux-glibc-x64', 'linux-glibc-arm64',
  'linux-musl-x64', 'linux-musl-arm64',
])

function selectTarget(platform = process.platform, arch = process.arch, libc) {
  if (platform === 'win32' && arch === 'x64') return 'win-x64'
  if (platform === 'darwin' && arch === 'arm64') return 'macos-arm64'
  if (platform === 'linux' && (arch === 'x64' || arch === 'arm64')) {
    libc ??= process.report.getReport().header.glibcVersionRuntime ? 'glibc' : 'musl'
    const target = 'linux-' + libc + '-' + arch
    if (targets.includes(target)) return target
  }
  throw new Error('FFmpeg 原生模块不支持当前平台：' + platform + '/' + arch)
}

function digest(file) {
  const stat = fs.lstatSync(file)
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('FFmpeg 原生文件必须是普通文件：' + file)
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex')
}

function inspectTarget(root, target) {
  if (!targets.includes(target)) throw new Error('Unknown FFmpeg target: ' + target)
  const directory = path.join(root, target)
  if (fs.lstatSync(directory).isSymbolicLink()) throw new Error('FFmpeg 平台目录不能是符号链接')
  const metadata = JSON.parse(fs.readFileSync(path.join(directory, 'build.json'), 'utf8'))
  if (metadata.schemaVersion !== 1 || metadata.target !== target || metadata.filename !== filename ||
      !/^[a-f0-9]{64}$/.test(metadata.sha256)) {
    throw new Error('FFmpeg 构建元数据无效：' + target)
  }
  const file = path.join(directory, filename)
  if (digest(file) !== metadata.sha256) throw new Error('FFmpeg 原生模块校验失败：' + target)
  return { target, file, metadata }
}

function inspectBundle(root, options = {}) {
  const selected = options.allTargets ? targets : [options.target || selectTarget()]
  return selected.map(target => inspectTarget(root, target))
}

function loadNative(root, options = {}) {
  const inspected = inspectTarget(root, options.target || selectTarget())
  const cacheRoot = options.cacheDir || path.join(os.tmpdir(), 'lucky-lillia-ffmpeg')
  const cacheDirectory = path.join(cacheRoot, inspected.target)
  fs.mkdirSync(cacheDirectory, { recursive: true })
  for (const directory of [cacheRoot, cacheDirectory]) {
    if (fs.lstatSync(directory).isSymbolicLink()) throw new Error('FFmpeg 缓存目录不能是符号链接')
  }
  const cacheFile = path.join(cacheDirectory, 'LuckyLillia.FFmpeg.' + inspected.metadata.sha256 + '.node')
  const verifyCache = () => {
    if (digest(cacheFile) !== inspected.metadata.sha256) throw new Error('FFmpeg 原生缓存已损坏：' + cacheFile)
  }
  if (fs.existsSync(cacheFile)) {
    verifyCache()
  } else {
    const temporary = path.join(cacheDirectory, '.' + process.pid + '-' + randomUUID() + '.tmp')
    try {
      fs.copyFileSync(inspected.file, temporary, fs.constants.COPYFILE_EXCL)
      if (digest(temporary) !== inspected.metadata.sha256) throw new Error('FFmpeg 复制期间原生模块发生变化')
      // Hard-link promotion is atomic and never replaces an addon another process has loaded.
      try {
        fs.linkSync(temporary, cacheFile)
      } catch (error) {
        if (error.code !== 'EEXIST') throw error
      }
      verifyCache()
    } finally {
      try { fs.unlinkSync(temporary) } catch (error) { if (error.code !== 'ENOENT') throw error }
    }
  }
  const addon = require(cacheFile)
  for (const method of ['probe', 'decodeAudio', 'encodeAudio', 'transcodeAudio', 'thumbnail', 'version', 'silkVersion']) {
    if (typeof addon[method] !== 'function') throw new Error('FFmpeg 原生模块缺少接口：' + method)
  }
  return addon
}

module.exports = { targets, selectTarget, inspectBundle, loadNative }

import { createHash, randomUUID } from 'node:crypto'
import { lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'

const root = import.meta.dirname
const targets = ['win-x64', 'macos-arm64', 'linux-glibc-x64', 'linux-glibc-arm64', 'linux-musl-x64', 'linux-musl-arm64']
const filename = 'LuckyLillia.FFmpeg.node'
const digest = bytes => createHash('sha256').update(bytes).digest('hex')
const sha256 = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
const within = (parent, child) => {
  const relative = path.relative(parent, child)
  return relative !== '' && !relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative)
}
const fail = message => { throw new Error(message) }
const regularFile = file => {
  if (!lstatSync(file).isFile()) fail('Expected a regular file: ' + file)
  return readFileSync(file)
}
const json = file => JSON.parse(regularFile(file).toString('utf8'))

let plugin = path.resolve(root, '..')
let artifacts = path.join(root, 'artifacts')
let check = false
const args = process.argv.slice(2)
for (let index = 0; index < args.length; index++) {
  const arg = args[index]
  if (arg === '--check') check = true
  else if (arg === '--help') {
    console.log('Usage: node sync-to-plugin.mjs [--plugin PATH] [--artifacts PATH] [--check]\nValidates all six artifacts before copying binaries, manifests and licenses to the optional FFmpeg plugin.')
    process.exit(0)
  } else if (arg === '--plugin' || arg === '--artifacts') {
    const value = args[++index]
    if (!value || value.startsWith('--')) fail('Missing path for ' + arg)
    if (arg === '--plugin') plugin = path.resolve(value)
    else artifacts = path.resolve(value)
  } else fail('Unknown argument: ' + arg)
}

// Read and validate every source and artifact before changing any plugin files.
const source = json(path.join(root, 'ffmpeg-source.json'))
if (source.schemaVersion !== 1 || !sha256(source.sourceTreeSha256) ||
    typeof source.upstream?.url !== 'string' || !source.upstream.url ||
    !/^[a-f0-9]{40}$/.test(source.upstream?.commit) || !Array.isArray(source.patches)) {
  fail('Invalid ffmpeg-source.json')
}
if (source.sourceHashExclusions !== undefined &&
    (!Array.isArray(source.sourceHashExclusions) || !sha256(source.fullSourceTreeSha256) ||
     !Number.isSafeInteger(source.fullSourceFileCount) || source.fullSourceFileCount <= 0 ||
     source.sourceHashExclusions.some(name => typeof name !== 'string' || !within(root, path.resolve(root, name))))) {
  fail('Invalid full source tree or canonical hash exclusions')
}
const patchNames = new Set()
for (const patch of source.patches) {
  if (typeof patch.file !== 'string' || !sha256(patch.sha256) || patchNames.has(patch.file)) fail('Invalid or duplicate source patch')
  patchNames.add(patch.file)
  const file = path.resolve(root, patch.file)
  if (!within(root, file) || !within(realpathSync(root), realpathSync(file)) || digest(regularFile(file)) !== patch.sha256) {
    fail('Source patch hash or path mismatch: ' + patch.file)
  }
}
const addonSourceSha256 = digest(regularFile(path.join(root, 'addon.cc')))
const componentConfigSha256 = digest(regularFile(path.join(root, 'components.txt')))
const silk = json(path.join(root, 'silk-source.json'))
if (silk.schemaVersion !== 1 || !sha256(silk.sourceTreeSha256) ||
    typeof silk.upstream?.url !== 'string' || !silk.upstream.url ||
    !/^[a-f0-9]{40}$/.test(silk.upstream?.commit)) {
  fail('Invalid silk-source.json')
}
const silkSource = { upstream: { url: silk.upstream.url, commit: silk.upstream.commit }, sourceTreeSha256: silk.sourceTreeSha256 }
const files = []
let ffmpegVersion
for (const target of targets) {
  const directory = path.join(artifacts, target)
  const metadataBytes = regularFile(path.join(directory, 'build.json'))
  const metadata = JSON.parse(metadataBytes.toString('utf8'))
  const binary = regularFile(path.join(directory, filename))
  if (metadata.schemaVersion !== 1 || metadata.target !== target || metadata.filename !== filename ||
      metadata.napiVersion !== 8 || typeof metadata.ffmpegVersion !== 'string' || !metadata.ffmpegVersion ||
      metadata.sha256 !== digest(binary) || metadata.addonSourceSha256 !== addonSourceSha256 ||
      metadata.componentConfigSha256 !== componentConfigSha256 ||
      metadata.source?.sourceTreeSha256 !== source.sourceTreeSha256 ||
      metadata.silkSource?.sourceTreeSha256 !== silkSource.sourceTreeSha256 ||
      metadata.silkSource?.upstream?.url !== silkSource.upstream.url ||
      metadata.silkSource?.upstream?.commit !== silkSource.upstream.commit) {
    fail('Artifact source, config, target or binary mismatch: ' + target)
  }
  if (ffmpegVersion && ffmpegVersion !== metadata.ffmpegVersion) fail('FFmpeg versions differ between targets')
  ffmpegVersion = metadata.ffmpegVersion
  files.push({ name: target + '/' + filename, bytes: binary }, { name: target + '/build.json', bytes: metadataBytes })
}

let licenseCount = 0
function collectLicenses(directory, prefix = 'licenses') {
  if (!lstatSync(directory).isDirectory()) fail('Expected a license directory: ' + directory)
  for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const file = path.join(directory, entry.name)
    const name = prefix + '/' + entry.name
    if (entry.isDirectory()) collectLicenses(file, name)
    else if (entry.isFile()) {
      files.push({ name, bytes: regularFile(file) })
      licenseCount++
    } else fail('Unexpected non-regular license file: ' + name)
  }
}
collectLicenses(path.join(root, 'licenses'))
if (!licenseCount) fail('License directory is empty')
const buildSources = {
  schemaVersion: 1,
  addonSourceSha256,
  componentConfigSha256,
  ffmpegVersion,
  napiVersion: 8,
  silkSource,
  source: {
    sourceTreeSha256: source.sourceTreeSha256,
    upstream: { url: source.upstream.url, commit: source.upstream.commit },
    patches: source.patches.map(({ file, sha256 }) => ({ file, sha256 })),
    ...(source.legacySnapshotSha256 ? { legacySnapshotSha256: source.legacySnapshotSha256 } : {}),
    ...(source.version ? { version: source.version } : {}),
    ...(source.sourceHashExclusions ? { sourceHashExclusions: source.sourceHashExclusions } : {}),
    ...(source.fullSourceTreeSha256 ? { fullSourceTreeSha256: source.fullSourceTreeSha256 } : {}),
    ...(source.fullSourceFileCount ? { fullSourceFileCount: source.fullSourceFileCount } : {}),
  },
  targets,
}
files.push({ name: 'build-sources.json', bytes: Buffer.from(JSON.stringify(buildSources, null, 2) + '\n') })

if (!check) {
  if (json(path.join(plugin, 'package.json')).name !== 'lucky-lillia-plugin-ffmpeg') fail('Destination is not the FFmpeg plugin: ' + plugin)
  const destination = path.join(plugin, 'native')
  regularFile(path.join(destination, 'loader.cjs'))
  for (const file of files) {
    const output = path.join(destination, file.name)
    mkdirSync(path.dirname(output), { recursive: true })
    const temporary = output + '.' + randomUUID() + '.tmp'
    try {
      writeFileSync(temporary, file.bytes, { flag: 'wx' })
      renameSync(temporary, output)
    } finally {
      rmSync(temporary, { force: true })
    }
  }
}
console.log(JSON.stringify({ checked: true, synced: !check, targets, addonSourceSha256, componentConfigSha256, sourceTreeSha256: source.sourceTreeSha256 }, null, 2))

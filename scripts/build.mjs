import assert from 'node:assert/strict'
import { copyFileSync, mkdirSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'

const root = path.resolve(import.meta.dirname, '..')
const require = createRequire(import.meta.url)
const nativeRoot = path.join(root, 'native')
const loader = require('../native/loader.cjs')
const source = JSON.parse(readFileSync(path.join(nativeRoot, 'build-sources.json'), 'utf8'))
assert.equal(source.schemaVersion, 1, 'invalid native source record')
assert.deepEqual(source.targets, loader.targets, 'six native targets must be included')
assert.match(source.silkSource?.sourceTreeSha256 || '', /^[a-f0-9]{64}$/, 'missing SILK source hash')
assert.match(source.silkSource?.upstream?.commit || '', /^[a-f0-9]{40}$/, 'missing SILK source commit')
assert.ok(source.silkSource?.upstream?.url, 'missing SILK source URL')
for (const { target, metadata } of loader.inspectBundle(nativeRoot, { allTargets: true })) {
  assert.equal(metadata.napiVersion, 8, target + ': unsupported N-API version')
  assert.equal(metadata.addonSourceSha256, source.addonSourceSha256, target + ': stale addon source')
  assert.equal(metadata.componentConfigSha256, source.componentConfigSha256, target + ': stale component config')
  assert.equal(metadata.source?.sourceTreeSha256, source.source.sourceTreeSha256, target + ': stale FFmpeg source')
  assert.equal(metadata.ffmpegVersion, source.ffmpegVersion, target + ': mismatched FFmpeg version')
  assert.equal(metadata.silkSource?.sourceTreeSha256, source.silkSource.sourceTreeSha256, target + ': stale SILK source')
  assert.deepEqual(metadata.silkSource?.upstream, source.silkSource.upstream, target + ': mismatched SILK source commit')
}
mkdirSync(path.join(root, 'lib'), { recursive: true })
mkdirSync(path.join(root, 'output'), { recursive: true })
for (const file of ['index.js', 'index.d.ts']) copyFileSync(path.join(root, 'src', file), path.join(root, 'lib', file))
console.log('Built optional FFmpeg plugin; all six native artifacts and source hashes verified.')

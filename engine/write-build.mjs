import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, cpSync, mkdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readSource } from './prepare-source.mjs';
import { readSilkSource } from './prepare-silk.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const [target, directory, work] = process.argv.slice(2);
if (!target || !directory || !work) throw new Error('Usage: write-build.mjs TARGET OUTPUT WORK');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const filename = 'LuckyLillia.FFmpeg.node';
const source = readSource();
for (const name of ['ffmpeg-source.json', 'components.txt', 'silk-source.json']) {
  if (hash(readFileSync(path.join(work, name))) !== hash(readFileSync(path.join(here, name)))) {
    throw new Error(name + ' changed after compilation; rebuild before writing metadata');
  }
}
const addonSourceSha256 = hash(readFileSync(path.join(work, 'addon.cc')));
const silkSource = readSilkSource();
const silkBuild = JSON.parse(readFileSync(path.join(work, 'silk-build.json'), 'utf8'));
if (JSON.stringify(silkBuild.source) !== JSON.stringify(silkSource) ||
    hash(readFileSync(process.env.SILK_LIBRARY)) !== silkBuild.librarySha256) throw new Error('SILK library/source receipt mismatch');
const reuseFile = path.join(work, 'reused-libav-cache.json');
const reuse = existsSync(reuseFile) ? JSON.parse(readFileSync(reuseFile, 'utf8')) : undefined;
if (hash(readFileSync(path.join(here, 'addon.cc'))) !== addonSourceSha256) {
  throw new Error('addon.cc changed after compilation; rebuild before writing metadata');
}
const pins = readFileSync(path.join(here, 'sources.tsv'), 'utf8').split(/\r?\n/)
  .filter(line => line && !line.startsWith('#')).map(line => {
    const [name, version, sha256, url] = line.split(/\s+/);
    return { name, version, sha256, url };
  });
const metadata = {
  schemaVersion: 1, target, filename,
  sha256: hash(readFileSync(path.join(directory, filename))),
  addonSourceSha256,
  ffmpegVersion: source.version || '8.0.git', napiVersion: 8,
  source: { kind: reuse ? 'verified-static-cache' : 'git-submodule-with-patches', upstream: source.upstream, patches: source.patches,
    ...(reuse ? { compiledSource: reuse.source, cacheReceiptSha256: hash(readFileSync(reuseFile)) } : {}),
    sourceTreeSha256: source.sourceTreeSha256, fullSourceTreeSha256: source.fullSourceTreeSha256,
    fullSourceFileCount: source.fullSourceFileCount, sourceHashExclusions: source.sourceHashExclusions },
  componentConfigSha256: hash(readFileSync(path.join(work, 'components.txt'))),
  silkSource: { upstream: silkSource.upstream, sourceTreeSha256: silkSource.sourceTreeSha256, version: silkSource.version },
  silkLibrarySha256: silkBuild.librarySha256, silkRecipeSha256: silkBuild.recipeSha256,
  compiler: process.env.FFMPEG_COMPILER,
  dependencies: process.env.FFMPEG_DEPS_KIND || 'pinned-static',
  dynamicLibraries: readFileSync(path.join(work, 'dynamic-libraries.txt'), 'utf8').trim().split(/\r?\n/),
  licenses: ['LGPL-3.0-or-later', 'LGPL-2.0-or-later', 'Apache-2.0', 'BSD-3-Clause', 'Zlib', 'BSD-3-Clause-Clear', 'MIT'],
  sources: pins,
};
writeFileSync(path.join(directory, 'build.json'), JSON.stringify(metadata, null, 2) + String.fromCharCode(10));
const notices = path.join(directory, '../licenses');
mkdirSync(notices, { recursive: true });
cpSync(path.join(here, 'licenses'), notices, { recursive: true });

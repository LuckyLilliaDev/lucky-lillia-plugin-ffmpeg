import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readSource } from './prepare-source.mjs';
const root = path.dirname(fileURLToPath(import.meta.url));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const json = file => JSON.parse(readFileSync(file, 'utf8'));
const safe = (base, name) => {
  const file = path.resolve(base, name);
  if (!file.startsWith(path.resolve(base) + path.sep)) throw new Error('Invalid cache path: ' + name);
  return file;
};
function validate(record, target) {
  const source = readSource();
  if (record.schemaVersion !== 1 || record.target !== target ||
      record.source?.sourceTreeSha256 !== source.sourceTreeSha256 ||
      record.componentConfigSha256 !== hash(readFileSync(path.join(root, 'components.txt')))) {
    throw new Error('Cached libav target, source or component config differs from this build');
  }
}
export function verifyLibavCache(target, directory) {
  const record = json(path.join(directory, 'libav-cache.json'));
  validate(record, target);
  if (!Array.isArray(record.files) || !record.files.length) throw new Error('Empty libav cache receipt');
  for (const entry of record.files) {
    if (hash(readFileSync(safe(directory, entry.path))) !== entry.sha256) {
      throw new Error('Cached libav build input changed: ' + entry.path);
    }
  }
  safe(directory, record.ffmpegBuildDirectory);
  return record;
}
const [operation, target, directory, buildDirectory, metadataFile] = process.argv.slice(2);
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (operation === 'capture') {
    const metadata = json(metadataFile);
    validate(metadata, target);
    if (hash(readFileSync(path.join(path.dirname(metadataFile), metadata.filename))) !== metadata.sha256) throw new Error('Completed build binary hash mismatch');
    const files = [];
    const add = relative => files.push({ path: relative.replaceAll(path.sep, '/'), sha256: hash(readFileSync(safe(directory, relative))) });
    function walk(relative) {
      for (const entry of readdirSync(safe(directory, relative), { withFileTypes: true })) {
        const name = path.join(relative, entry.name);
        if (entry.isDirectory()) walk(name);
        else if (entry.isFile()) add(name);
        else throw new Error('Non-regular cached build input: ' + name);
      }
    }
    for (const input of ['libav/include', 'libav/lib', 'prefix/include', 'prefix/lib']) walk(input);
    const ffmpegBuildDirectory = path.relative(directory, buildDirectory).replaceAll(path.sep, '/');
    for (const input of ['config.h', 'ffbuild/config.mak']) add(path.join(ffmpegBuildDirectory, input));
    const record = { schemaVersion: 1, target, source: metadata.source, ffmpegVersion: metadata.ffmpegVersion,
      componentConfigSha256: metadata.componentConfigSha256, compiler: metadata.compiler,
      dependencies: metadata.dependencies, ffmpegBuildDirectory, files: files.sort((a, b) => a.path.localeCompare(b.path)) };
    writeFileSync(path.join(directory, 'libav-cache.json'), JSON.stringify(record, null, 2) + '\n');
    console.log('Captured verified completed libav cache: ' + record.files.length + ' build inputs');
  } else if (operation === 'verify') {
    const record = verifyLibavCache(target, directory);
    if (buildDirectory) writeFileSync(buildDirectory, JSON.stringify(record, null, 2) + '\n');
    console.log('Verified cached libav source/config and all ' + record.files.length + ' build inputs');
  } else throw new Error('Usage: libav-cache.mjs capture TARGET WORK FFMPEG_BUILD BUILD_JSON | verify TARGET WORK [RECEIPT_COPY]');
}

import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sourceTree } from './prepare-source.mjs';
const root = path.dirname(fileURLToPath(import.meta.url));
export function readSilkSource() {
  const record = JSON.parse(readFileSync(path.join(root, 'silk-source.json'), 'utf8'));
  if (record.schemaVersion !== 1 || !/^[0-9a-f]{40}$/.test(record.upstream?.commit) ||
      !/^[0-9a-f]{64}$/.test(record.sourceTreeSha256) || !Array.isArray(record.paths) ||
      record.paths.some(name => typeof name !== 'string' || name.startsWith('/') || name.split('/').includes('..'))) {
    throw new Error('Invalid SILK source manifest');
  }
  return record;
}
export function prepareSilkSource(destination) {
  const record = readSilkSource();
  const submodule = path.join(root, 'silk-sdk');
  const git = (...args) => execFileSync('git', ['-C', submodule, ...args], { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 });
  if (path.resolve(git('rev-parse', '--show-toplevel').trim()) !== submodule ||
      git('rev-parse', 'HEAD').trim() !== record.upstream.commit ||
      git('status', '--porcelain', '--untracked-files=normal').trim()) {
    throw new Error('SILK SDK submodule must be initialized, clean and at its pinned commit');
  }
  destination = path.resolve(destination);
  if (destination === root || destination === submodule || destination.startsWith(submodule + path.sep)) throw new Error('Use a separate SILK source directory');
  const verify = directory => {
    const actual = sourceTree(directory, new Set(['.silk-source-ready']));
    if (actual.sourceTreeSha256 !== record.sourceTreeSha256 || actual.fileCount !== record.fileCount) throw new Error('SILK source tree mismatch');
  };
  if (existsSync(destination)) { verify(destination); return destination; }
  mkdirSync(path.dirname(destination), { recursive: true });
  const staging = mkdtempSync(destination + '.prepare-');
  try {
    // Export only pinned SDK blobs. git archive may prefetch unrelated Windows
    // executables even with path filters in a partial/sparse clone.
    const entries = git('ls-tree', '-r', '-z', record.upstream.commit, '--', ...record.paths).split('\0').filter(Boolean).map(line => {
      const match = line.match(/^(100644|100755) blob ([0-9a-f]{40})\t(.+)$/);
      if (!match) throw new Error('Unexpected SILK tree entry: ' + line);
      return { mode: match[1], object: match[2], name: match[3] };
    });
    const objects = execFileSync('git', ['-C', submodule, 'cat-file', '--batch'], {
      input: entries.map(entry => entry.object).join('\n') + '\n', maxBuffer: 16 * 1024 * 1024,
    });
    let offset = 0;
    for (const entry of entries) {
      const newline = objects.indexOf(10, offset);
      const header = objects.subarray(offset, newline).toString().split(' ');
      if (newline < offset || header[0] !== entry.object || header[1] !== 'blob') throw new Error('Invalid SILK Git object');
      const size = Number(header[2]);
      if (!Number.isSafeInteger(size) || size < 0 || newline + 1 + size >= objects.length) throw new Error('Truncated SILK Git object');
      const file = path.resolve(staging, entry.name);
      if (!file.startsWith(staging + path.sep)) throw new Error('Invalid SILK source path');
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, objects.subarray(newline + 1, newline + 1 + size));
      chmodSync(file, entry.mode === '100755' ? 0o755 : 0o644);
      offset = newline + 1 + size + 1;
    }
    if (offset !== objects.length) throw new Error('Unexpected trailing SILK object data');
    verify(staging);
    writeFileSync(path.join(staging, '.silk-source-ready'), JSON.stringify(record) + '\n');
    renameSync(staging, destination);
    return destination;
  } finally {
    if (existsSync(staging)) rmSync(staging, { recursive: true, force: true });
  }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (!process.argv[2]) throw new Error('Usage: node prepare-silk.mjs OUTPUT_SOURCE_DIRECTORY');
  console.log(prepareSilkSource(process.argv[2]));
}

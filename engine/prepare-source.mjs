import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
export function readSource() {
  const source = JSON.parse(readFileSync(path.join(root, 'ffmpeg-source.json'), 'utf8'));
  if (source.schemaVersion !== 1 || !/^[a-f0-9]{40}$/.test(source.upstream?.commit) ||
      !/^[a-f0-9]{64}$/.test(source.sourceTreeSha256) || !Array.isArray(source.patches)) {
    throw new Error('Invalid ffmpeg-source.json');
  }
  if (source.sourceHashExclusions !== undefined &&
      (!Array.isArray(source.sourceHashExclusions) || !/^[a-f0-9]{64}$/.test(source.fullSourceTreeSha256) ||
       !Number.isSafeInteger(source.fullSourceFileCount) || source.fullSourceFileCount <= 0)) {
    throw new Error('Invalid complete source tree metadata');
  }
  for (const patch of source.patches) {
    const file = path.resolve(root, patch.file);
    if (!file.startsWith(root + path.sep) || !/^[a-f0-9]{64}$/.test(patch.sha256) ||
        hash(readFileSync(file)) !== patch.sha256) throw new Error('Patch hash mismatch: ' + patch.file);
  }
  return source;
}
export function sourceTree(directory, exclude = new Set(), legacyExcludes = []) {
  const names = [];
  function walk(relative = '') {
    for (const entry of readdirSync(path.join(directory, relative), { withFileTypes: true })) {
      const name = relative ? relative + '/' + entry.name : entry.name;
      if (exclude.has(name)) continue;
      if (entry.isDirectory()) walk(name);
      else if (entry.isFile()) names.push(name);
      else throw new Error('Unexpected non-regular source file: ' + name);
    }
  }
  walk();
  const manifest = names.sort().map(name => {
    const bytes = readFileSync(path.join(directory, name));
    return { path: name, sha256: hash(bytes), size: bytes.length };
  });
  const excluded = new Set();
  for (const name of legacyExcludes) {
    if (typeof name !== 'string' || excluded.has(name) || !manifest.some(file => file.path === name)) {
      throw new Error('Invalid historical snapshot exclusion: ' + name);
    }
    excluded.add(name);
  }
  const historical = manifest.filter(file => !excluded.has(file.path));
  return { sourceTreeSha256: hash(JSON.stringify(manifest)), fileCount: manifest.length,
    historicalSourceTreeSha256: hash(JSON.stringify(historical)), historicalFileCount: historical.length };
}
export function prepareSource(destination) {
  const source = readSource();
  const submodule = path.join(root, 'ffmpeg');
  const git = (...args) => execFileSync('git', ['-C', submodule, ...args], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  const top = git('rev-parse', '--show-toplevel').trim();
  if (path.resolve(top) !== path.resolve(submodule) || git('rev-parse', 'HEAD').trim() !== source.upstream.commit) {
    throw new Error('Initialize the FFmpeg submodule at its pinned commit: git submodule update --init --recursive');
  }
  if (git('status', '--porcelain', '--untracked-files=normal').trim()) {
    throw new Error('The FFmpeg submodule must be clean; preserve custom changes as patches');
  }
  destination = path.resolve(destination);
  if (destination === root || destination === submodule || destination.startsWith(submodule + path.sep)) {
    throw new Error('Choose a separate output source directory');
  }
  const version = source.version || '8.0.git';
  const verify = (directory, exclude) => {
    const actual = sourceTree(directory, exclude, source.sourceHashExclusions || []);
    if (actual.sourceTreeSha256 !== (source.fullSourceTreeSha256 || source.sourceTreeSha256) ||
        actual.historicalSourceTreeSha256 !== source.sourceTreeSha256 ||
        (source.fullSourceFileCount && actual.fileCount !== source.fullSourceFileCount) ||
        (source.fileCount && actual.historicalFileCount !== source.fileCount)) {
      throw new Error('Prepared FFmpeg source differs from the preserved custom source: ' + JSON.stringify(actual));
    }
  };
  if (existsSync(destination)) {
    const receipt = JSON.parse(readFileSync(path.join(destination, '.source-ready'), 'utf8'));
    if (receipt.sourceTreeSha256 !== source.sourceTreeSha256 || receipt.version !== version) {
      throw new Error('Source cache mismatch; use a new work directory');
    }
    verify(destination, new Set(['.source-ready', ...(receipt.generatedVersion ? ['VERSION'] : [])]));
    if (readFileSync(path.join(destination, 'VERSION'), 'utf8').trim() !== version) throw new Error('Source VERSION changed');
    return destination;
  }
  mkdirSync(path.dirname(destination), { recursive: true });
  const staging = mkdtempSync(destination + '.prepare-');
  const archive = staging + '.tar';
  try {
    git('archive', '--format=tar', '--output=' + archive, source.upstream.commit);
    // Relative archive names also work with MSYS GNU tar, which treats drive
    // letters in absolute Windows paths as remote archive syntax.
    execFileSync('tar', ['-xf', path.basename(archive), '-C', path.basename(staging)], { cwd: path.dirname(staging) });
    const gitdir = git('rev-parse', '--absolute-git-dir').trim();
    for (const patch of source.patches) {
      execFileSync('git', ['--git-dir=' + gitdir, '--work-tree=' + staging, 'apply', '--whitespace=nowarn', path.join(root, patch.file)], { cwd: staging });
    }
    verify(staging);
    const generatedVersion = !existsSync(path.join(staging, 'VERSION'));
    if (!generatedVersion && readFileSync(path.join(staging, 'VERSION'), 'utf8').trim() !== version) throw new Error('Pinned VERSION mismatch');
    if (generatedVersion) writeFileSync(path.join(staging, 'VERSION'), version + '\n');
    writeFileSync(path.join(staging, '.source-ready'), JSON.stringify({ sourceTreeSha256: source.sourceTreeSha256, version, generatedVersion }) + '\n');
    renameSync(staging, destination);
    return destination;
  } finally {
    // Only remove the unique staging paths created by this invocation.
    rmSync(archive, { force: true });
    if (existsSync(staging)) rmSync(staging, { recursive: true, force: true });
  }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const destination = process.argv[2];
  if (!destination) throw new Error('Usage: node prepare-source.mjs OUTPUT_SOURCE_DIRECTORY');
  console.log(prepareSource(destination));
}

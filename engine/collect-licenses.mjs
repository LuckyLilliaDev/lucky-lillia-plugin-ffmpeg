import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { prepareSource } from './prepare-source.mjs';
import { prepareSilkSource } from './prepare-silk.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const cache = path.resolve(process.argv[2] || path.join(here, 'output/ffmpeg-downloads'));
const destination = path.join(here, 'licenses');
mkdirSync(destination, { recursive: true });
const pins = new Map(readFileSync(path.join(here, 'sources.tsv'), 'utf8').split(/\r?\n/)
  .filter(line => line && !line.startsWith('#')).map(line => {
    const [name, version, sha256, url] = line.split(/\s+/);
    return [name, { version, sha256, url }];
  }));
const entries = [
  ['lame', 'lame-3.100/COPYING', 'LAME-LGPL-2.0.txt'],
  ['lame', 'lame-3.100/LICENSE', 'LAME-NOTICE.txt'],
  ['opencore-amr', 'opencore-amr-0.1.6/LICENSE', 'OpenCORE-AMR-Apache-2.0.txt'],
  ['speex', 'speex-1.2.1/COPYING', 'Speex-BSD.txt'],
  ['ogg', 'libogg-1.3.5/COPYING', 'Ogg-BSD.txt'],
  ['vorbis', 'libvorbis-1.3.7/COPYING', 'Vorbis-BSD.txt'],
  ['zlib', 'zlib-1.3.1/LICENSE', 'Zlib.txt'],
];
for (const [name, member, output] of entries) {
  const pin = pins.get(name);
  const archive = path.join(cache, path.basename(new URL(pin.url).pathname));
  if (createHash('sha256').update(readFileSync(archive)).digest('hex') !== pin.sha256) throw new Error('Source hash mismatch: ' + name);
  writeFileSync(path.join(destination, output), execFileSync('tar', ['-xOf', archive, member]));
}
const customSource = prepareSource(path.join(here, 'output/license-source'));
for (const member of ['COPYING.LGPLv3', 'COPYING.GPLv3', 'LICENSE.md']) {
  writeFileSync(path.join(destination, 'FFmpeg-' + member + '.txt'), readFileSync(path.join(customSource, member)));
}
const silkSource = prepareSilkSource(path.join(here, 'output/license-silk-source'));
const silkHeader = readFileSync(path.join(silkSource, 'silk/interface/SKP_Silk_SDK_API.h'), 'utf8');
writeFileSync(path.join(destination, 'SILK-Skype-BSD-3-Clause-Clear.txt'), silkHeader.slice(0, silkHeader.indexOf('*/') + 2) + '\n');
writeFileSync(path.join(destination, 'SILK-Mirror-MIT.txt'), readFileSync(path.join(silkSource, 'LICENSE')));
console.log('Collected license notices from verified sources');

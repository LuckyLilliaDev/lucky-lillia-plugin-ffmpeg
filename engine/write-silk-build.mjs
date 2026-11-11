import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { readSilkSource } from './prepare-silk.mjs';
const [work, prefix, recipeSha256] = process.argv.slice(2);
const hash = data => createHash('sha256').update(data).digest('hex');
const source = readSilkSource();
const compiled = JSON.parse(readFileSync(path.join(work, 'silk-source.json'), 'utf8'));
if (JSON.stringify(source) !== JSON.stringify(compiled)) throw new Error('SILK source metadata changed during compilation');
writeFileSync(path.join(work, 'silk-build.json'), JSON.stringify({ schemaVersion:1, source, recipeSha256,
  librarySha256:hash(readFileSync(path.join(prefix, 'lib/libSKP_SILK_SDK.a'))) }, null, 2)+'\n');

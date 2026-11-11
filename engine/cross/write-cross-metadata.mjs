import fs from 'node:fs';
import path from 'node:path';
const [target, output, work] = process.argv.slice(2);
const file = path.join(output, 'build.json');
const value = JSON.parse(fs.readFileSync(file, 'utf8'));
value.licenses = [...new Set([...value.licenses, 'Apache-2.0 WITH LLVM-exception', 'MIT'])];
value.crossBuild = {
  toolchain: 'Zig 0.14.1',
  libcBaseline: target.includes('glibc') ? 'glibc 2.28' : target.includes('musl') ? 'musl ABI, Zig 0.14.1 bundled libc' : undefined,
  macosDeploymentTarget: target.startsWith('macos') ? '11.0' : undefined,
  asm: false,
  staticRuntimes: ['LLVM libc++', 'LLVM libc++abi', 'LLVM libunwind', 'Zig compiler-rt'],
  sourceSha256: fs.readFileSync(path.join(work, 'addon-source-sha256.txt'), 'utf8').split(' ')[0],
  validation: 'compiled; run target smoke separately',
};
fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n');

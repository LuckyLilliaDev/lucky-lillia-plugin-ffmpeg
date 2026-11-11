#!/usr/bin/env bash
set -euo pipefail
here=$(cd -- "$(dirname -- "$0")" && pwd)
target=${1:-}
case "$target" in
  linux-glibc-x64|linux-glibc-arm64|linux-musl-x64|linux-musl-arm64|macos-arm64) ;;
  *) echo 'Usage: cross-build.sh TARGET (four Linux targets or macos-arm64)' >&2; exit 1 ;;
esac
source "$here/cross/env.sh"
fingerprint=$(cat "$here/sources.tsv" "$here/components.txt" "$here/ffmpeg-source.json" "$here/prepare-source.mjs" "$here/silk-source.json" "$here/prepare-silk.mjs" "$here/build-silk.sh" "$here/silk.mk" "$here/cross-build.sh" "$here/cross/"*.sh "$here/cross/macos-cc.py" | sha256sum | cut -d' ' -f1)
mkdir -p "$base/$target"
if [[ -f "$base/$target/build-inputs.sha256" ]] && [[ "$(cat "$base/$target/build-inputs.sha256")" != "$fingerprint" ]]; then
  echo 'Source pins or component flags changed. Set FFMPEG_CROSS_WORK to a fresh build directory.' >&2
  exit 1
fi
echo "$fingerprint" > "$base/$target/build-inputs.sha256"
for name in zlib lame opencore-amr speex ogg vorbis node-headers; do download_source "$name"; done
bash "$here/cross/prepare-source.sh"
bash "$here/cross/build-deps.sh" "$target"
bash "$here/cross/build-libav.sh" "$target"
bash "$here/cross/build-silk.sh" "$target"
bash "$here/cross/link-addon.sh" "$target"
bash "$here/cross/package-target.sh" "$target"
echo "Compiled $target. Run smoke.mjs with a Node runtime for that OS/architecture before release."

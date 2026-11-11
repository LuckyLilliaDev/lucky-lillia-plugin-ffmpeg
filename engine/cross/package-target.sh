#!/usr/bin/env bash
set -euo pipefail
target=$1
source "$(dirname -- "$0")/env.sh"
work="$base/$target"
output="$repo/artifacts/$target"
cmp "$repo/addon.cc" "$work/addon.cc"
mkdir -p "$output" "$work/relink/lib" "$work/relink/source"
if [ "$target" = macos-arm64 ]; then
  "$LLVM_OBJDUMP" --macho --dylibs-used "$work/LuckyLillia.FFmpeg.node" | tail -n +2 | awk -v self="$work/LuckyLillia.FFmpeg.node" '$1 != self {print $1}' > "$work/dynamic-libraries.txt"
  if grep -Ev '^(/usr/lib/|/System/Library/)' "$work/dynamic-libraries.txt"; then echo 'Unexpected dynamic dependency' >&2; exit 1; fi
  "$LLVM_OBJDUMP" --macho --private-headers --dylibs-used "$work/LuckyLillia.FFmpeg.node" > "$work/logs/binary-inspection.txt"
else
  readelf -d "$work/LuckyLillia.FFmpeg.node" | sed -n 's/.*Shared library: \[\(.*\)\]/\1/p' > "$work/dynamic-libraries.txt"
  if grep -Ev '^(libc\.so(\.6)?|libm\.so\.6|libpthread\.so\.0|libdl\.so\.2|librt\.so\.1|ld-linux[^/]*|libc\.musl-[^/]+\.so\.1)$' "$work/dynamic-libraries.txt"; then echo 'Unexpected dynamic dependency' >&2; exit 1; fi
  readelf -h -d -V "$work/LuckyLillia.FFmpeg.node" > "$work/logs/binary-inspection.txt"
fi
cp "$work/LuckyLillia.FFmpeg.node" "$output/"
SILK_LIBRARY="$work/install/lib/libSKP_SILK_SDK.a" FFMPEG_COMPILER='Zig 0.14.1 (Clang 19.1.7), WSL cross build' FFMPEG_DEPS_KIND=pinned-static \
  node "$repo/write-build.mjs" "$target" "$output" "$work"
node "$cross_here/write-cross-metadata.mjs" "$target" "$output" "$work"
cp "$work/addon.o" "$work/addon-source-sha256.txt" "$work/relink/"
cp "$work/install/lib/"*.a "$work/relink/lib/"
cp "$work/addon.cc" "$work/components.txt" "$repo/sources.tsv" "$work/ffmpeg-source.json" "$repo/prepare-source.mjs" "$work/relink/source/"
cp "$cross_here/"*.sh "$cross_here/"*.mjs "$cross_here/macos-cc.py" "$work/relink/source/"
cp "$repo/silk-source.json" "$repo/prepare-silk.mjs" "$repo/build-silk.sh" "$repo/write-silk-build.mjs" "$repo/silk.mk" "$work/silk-build.json" "$work/relink/source/"
cp "$repo/write-build.mjs" "$repo/libav-cache.mjs" "$work/relink/source/"
cp "$work/silk/toolchain.txt" "$work/relink/source/silk-toolchain.txt"
if [[ -f "$work/reused-libav-cache.json" ]]; then cp "$work/reused-libav-cache.json" "$work/relink/"; fi
mkdir -p "$work/relink/source/silk-sdk"
cp -R "$work/silk/source/." "$work/relink/source/silk-sdk/"
cp "$work/ffmpeg/config.h" "$work/ffmpeg/ffbuild/config.mak" "$output/build.json" "$work/relink/"
mkdir -p "$work/relink/licenses"
cp "$repo/licenses/"*.txt "$work/relink/licenses/"
tar -czf "$work/ffmpeg-relink-$target.tar.gz" -C "$work/relink" .
cp "$work/ffmpeg-relink-$target.tar.gz" "$base/"
printf 'Packaged %s\n' "$target"

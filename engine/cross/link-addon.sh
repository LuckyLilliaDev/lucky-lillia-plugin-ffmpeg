#!/usr/bin/env bash
set -euo pipefail
target=$1
source "$(dirname -- "$0")/env.sh"
work="$base/$target"
prefix="$work/install"
headers="$base/node-v22.22.2/include/node"
if [ ! -f "$headers/node_api.h" ]; then
  tar -xf "$downloads/node-v22.22.2-headers.tar.gz" -C "$base"
fi
output="$work/LuckyLillia.FFmpeg.node"
cp "$repo/addon.cc" "$work/addon.cc"
sha256sum "$work/addon.cc" > "$work/addon-source-sha256.txt"
flags=(-shared -Wl,-s)
if [ "$target" = macos-arm64 ]; then
  flags=(-dynamiclib -Wl,-undefined,dynamic_lookup)
fi
"$work/bin/cxx" -std=c++17 -O2 -fPIC -fvisibility=hidden -DNAPI_VERSION=8 -DNODE_GYP_MODULE_NAME=luckylillia_ffmpeg \
  -I"$headers" -I"$prefix/include" -c "$work/addon.cc" -o "$work/addon.o" > "$work/logs/link.log" 2>&1
"$work/bin/cxx" -O2 "$work/addon.o" "${flags[@]}" -static-libstdc++ -L"$prefix/lib" \
  -lavformat -lavcodec -lswresample -lswscale -lavutil -lmp3lame -lopencore-amrnb -lopencore-amrwb -lspeex -lvorbisenc -lvorbis -logg -lz -lSKP_SILK_SDK -lm -lpthread \
  -o "$output" >> "$work/logs/link.log" 2>&1
cmp "$repo/addon.cc" "$work/addon.cc"
file "$output"
sha256sum "$output"

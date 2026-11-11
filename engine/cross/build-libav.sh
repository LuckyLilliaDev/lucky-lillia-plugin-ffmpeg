#!/usr/bin/env bash
set -euo pipefail
target=$1
source "$(dirname -- "$0")/env.sh"
case "$target" in
  linux-glibc-x64|linux-musl-x64) arch=x86_64; os=linux;;
  linux-glibc-arm64|linux-musl-arm64) arch=aarch64; os=linux;;
  macos-arm64) arch=aarch64; os=darwin;;
  *) exit 2;;
esac
work="$base/$target"
prefix="$work/install"
source="$source_tree"
export CC="$work/bin/cc" CXX="$work/bin/cxx" AR="$work/bin/ar" RANLIB="$work/bin/ranlib"
export PKG_CONFIG_PATH="$prefix/lib/pkgconfig" PKG_CONFIG_LIBDIR="$prefix/lib/pkgconfig"
export MACOSX_DEPLOYMENT_TARGET=11.0
cp "$repo/ffmpeg-source.json" "$work/ffmpeg-source.json"
cp "$repo/components.txt" "$work/components.txt"
mapfile -t components < <(tr -d '\r' < "$work/components.txt")
stage() { printf '%s %s %s\n' "$(date -Is)" "$target" "$1" | tee "$work/status"; }
mkdir -p "$work/ffmpeg"
cd "$work/ffmpeg"
stage ffmpeg-configure
("$source/configure" \
    "${components[@]}" \
    --prefix="$prefix" --arch="$arch" --target-os="$os" --enable-cross-compile \
    --cc="$CC" --cxx="$CXX" --ar="$AR" --ranlib="$RANLIB" --nm="$LLVM_NM" \
    --disable-stripping --disable-asm --enable-pthreads \
    --pkg-config=pkg-config --pkg-config-flags=--static \
    --extra-cflags="-O2 -fPIC -I$prefix/include" --extra-ldflags="-L$prefix/lib"
  # Zig's glibc compatibility symbol makes this deprecated BSD/Linux probe
  # succeed although modern Linux has no sys/sysctl.h. Linux CPU discovery
  # uses sched_getaffinity/sysconf, so disable only the generated sysctl probe.
  if [ "$os" = linux ]; then sed -i 's/^#define HAVE_SYSCTL 1$/#define HAVE_SYSCTL 0/' config.h; fi
  stage ffmpeg-compile
  make -j"$JOBS"
  make install) > "$work/logs/ffmpeg.log" 2>&1
stage libraries-ready

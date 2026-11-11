#!/usr/bin/env bash
set -euo pipefail
target=$1
source "$(dirname -- "$0")/env.sh"
zig=$ZIG
jobs=$JOBS
case "$target" in
  linux-glibc-x64) triple=x86_64-linux-gnu.2.28; host=x86_64-linux-gnu; arch=x86_64; os=linux;;
  linux-glibc-arm64) triple=aarch64-linux-gnu.2.28; host=aarch64-linux-gnu; arch=aarch64; os=linux;;
  linux-musl-x64) triple=x86_64-linux-musl; host=x86_64-linux-musl; arch=x86_64; os=linux;;
  linux-musl-arm64) triple=aarch64-linux-musl; host=aarch64-linux-musl; arch=aarch64; os=linux;;
  macos-arm64) triple=aarch64-macos.11.0; host=aarch64-apple-darwin; arch=aarch64; os=darwin;;
  *) exit 2;;
esac
work="$base/$target"
prefix="$work/install"
mkdir -p "$work/bin" "$prefix" "$work/logs" "$work/src"
printf '#!/bin/sh
exec "%s" cc -target %s "$@"
' "$zig" "$triple" > "$work/bin/cc"
printf '#!/bin/sh
exec "%s" c++ -target %s "$@"
' "$zig" "$triple" > "$work/bin/cxx"
printf '#!/bin/sh
exec "%s" ar "$@"
' "$zig" > "$work/bin/ar"
printf '#!/bin/sh
exec "%s" ranlib "$@"
' "$zig" > "$work/bin/ranlib"
if [ "$target" = macos-arm64 ]; then cp "$cross_here/macos-cc.py" "$work/bin/cc"; fi
chmod +x "$work/bin/"*
export CC="$work/bin/cc" CXX="$work/bin/cxx" AR="$work/bin/ar" RANLIB="$work/bin/ranlib"
export CFLAGS="-O2 -fPIC" CXXFLAGS="-O2 -fPIC" CPPFLAGS="-I$prefix/include" LDFLAGS="-L$prefix/lib"
export PKG_CONFIG_PATH="$prefix/lib/pkgconfig" PKG_CONFIG_LIBDIR="$prefix/lib/pkgconfig"
export MACOSX_DEPLOYMENT_TARGET=11.0
export ZERO_AR_DATE=1
extract() {
  local name=$1 archive=$2
  if [ ! -d "$work/src/$name" ]; then
    tar -xf "$downloads/$archive" -C "$work/src"
  fi
}
stage() { printf '%s %s %s\n' "$(date -Is)" "$target" "$1" | tee "$work/status"; }
autolib() {
  local name=$1 archive=$2 marker=$3
  shift 3
  if [ -f "$prefix/lib/$marker" ]; then return; fi
  extract "$name" "$archive"
  stage "$name"
  (cd "$work/src/$name"
   ./configure --host="$host" --build=x86_64-pc-linux-gnu --prefix="$prefix" --disable-shared --enable-static "$@"
   make -j"$jobs"
   make install) > "$work/logs/$name.log" 2>&1
}
if [ ! -f "$prefix/lib/libz.a" ]; then
  extract zlib-1.3.1 zlib-1.3.1.tar.gz
  stage zlib
  (cd "$work/src/zlib-1.3.1"; CHOST="$host" ./configure --static --prefix="$prefix"; make -j"$jobs" AR="$AR" ARFLAGS=rc; make install AR="$AR" ARFLAGS=rc) > "$work/logs/zlib.log" 2>&1
fi
autolib lame-3.100 lame-3.100.tar.gz libmp3lame.a --disable-frontend --disable-decoder --disable-asm
autolib opencore-amr-0.1.6 opencore-amr-0.1.6.tar.gz libopencore-amrwb.a --disable-examples
autolib speex-1.2.1 speex-1.2.1.tar.gz libspeex.a --disable-binaries --disable-examples --disable-oggtest
autolib libogg-1.3.5 libogg-1.3.5.tar.xz libogg.a
autolib libvorbis-1.3.7 libvorbis-1.3.7.tar.xz libvorbisenc.a --disable-examples --disable-oggtest
stage dependencies-ready

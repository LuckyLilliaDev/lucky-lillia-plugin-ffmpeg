#!/usr/bin/env bash
# Native-host build. All builds use the verified submodule, patches and component allowlist.
set -euo pipefail
here=$(cd -- "$(dirname -- "$0")" && pwd)
repo=$here
target= deps_override= work= output= reuse_build=
usage() {
  echo 'Usage: build.sh --target TARGET [--work-dir DIR] [--output DIR] [--deps-prefix DIR] [--reuse-build VERIFIED_WORK]'
  echo 'Targets: win-x64 macos-arm64 linux-glibc-x64 linux-glibc-arm64 linux-musl-x64 linux-musl-arm64'
  echo 'Environment: CC CXX AR RANLIB STRIP CFLAGS CXXFLAGS LDFLAGS JOBS NODE FFMPEG_DOWNLOADS NODE_HEADERS NODE_LIB'
}
die() { echo "Error: $*" >&2; exit 1; }
while (($#)); do
  case "$1" in
    --target|--work-dir|--output|--deps-prefix|--reuse-build)
      (($# >= 2)) || die "Missing value for $1"
      case "$1" in
        --reuse-build) reuse_build=$2 ;;
        --target) target=$2 ;; --work-dir) work=$2 ;; --output) output=$2 ;; --deps-prefix) deps_override=$2 ;;
      esac
      shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) usage; die "Unknown argument $1" ;;
  esac
done
case "$target" in
  win-x64|macos-arm64|linux-glibc-x64|linux-glibc-arm64|linux-musl-x64|linux-musl-arm64) ;;
  *) usage; die 'Supply a supported --target' ;;
esac
host_arch=$(uname -m)
case "$host_arch" in x86_64|amd64) host_arch=x64 ;; aarch64|arm64) host_arch=arm64 ;; esac
[[ "$target" == *"-$host_arch" ]] || die "Target does not match host architecture $host_arch"
case "$(uname -s)" in
  MINGW*|MSYS*) [[ "$target" == win-* ]] || die 'Wrong operating system'; platform=win ;;
  Darwin) [[ "$target" == macos-* ]] || die 'Wrong operating system'; platform=macos ;;
  Linux)
    libc=glibc
    if compgen -G '/lib/ld-musl-*.so.1' >/dev/null; then libc=musl; fi
    [[ "$target" == linux-"$libc"-* ]] || die "Host requires linux-$libc"
    platform=linux ;;
  *) die 'Unsupported operating system' ;;
esac
NODE=${NODE:-node}
for tool in "$NODE" git make tar curl pkg-config; do command -v "$tool" >/dev/null || die "Missing tool: $tool"; done
if [[ "$platform" == macos ]]; then
  export CC=${CC:-clang} CXX=${CXX:-clang++} MACOSX_DEPLOYMENT_TARGET=${MACOSX_DEPLOYMENT_TARGET:-11.0}
else
  export CC=${CC:-gcc} CXX=${CXX:-g++}
fi
export AR=${AR:-ar} RANLIB=${RANLIB:-ranlib} STRIP=${STRIP:-strip}
export CFLAGS="-O2 -fPIC ${CFLAGS:-}" CXXFLAGS="-O2 -fPIC ${CXXFLAGS:-}" LDFLAGS=${LDFLAGS:-}
JOBS=${JOBS:-$(getconf _NPROCESSORS_ONLN 2>/dev/null || sysctl -n hw.ncpu)}
work=${work:-$repo/output/ffmpeg-native/$target}
output=${output:-$repo/artifacts/$target}
downloads=${FFMPEG_DOWNLOADS:-$repo/output/ffmpeg-downloads}
mkdir -p "$work" "$output" "$downloads"
work=$(cd "$work" && pwd); output=$(cd "$output" && pwd); downloads=$(cd "$downloads" && pwd)
[[ "$work$output$downloads" != *' '* ]] || die 'Build paths cannot contain spaces (configure/Makefile limitation)'
prefix=$work/prefix
mkdir -p "$work/src" "$work/build" "$prefix"
export PKG_CONFIG_LIBDIR="$prefix/lib/pkgconfig" PKG_CONFIG_PATH=
sha256() {
  if command -v sha256sum >/dev/null; then sha256sum "$1" | awk '{print $1}';
  else shasum -a 256 "$1" | awk '{print $1}'; fi
}
node_path() { if [[ "$platform" == win ]]; then cygpath -m "$1"; else echo "$1"; fi; }
source_field() { awk -v name="$1" -v field="$2" '$1 == name { print $field }' "$here/sources.tsv"; }
download() {
  local name=$1 url hash file
  url=$(source_field "$name" 4); hash=$(source_field "$name" 3)
  [[ "$hash" =~ ^[0-9a-f]{64}$ ]] || die "Missing source pin: $name"
  file="$downloads/${url##*/}"
  if [[ ! -f "$file" ]] || [[ "$(sha256 "$file")" != "$hash" ]]; then
    echo "Downloading $name" >&2
    curl --fail --location --retry 3 --connect-timeout 30 "$url" -o "$file.$$.part"
    [[ "$(sha256 "$file.$$.part")" == "$hash" ]] || die "SHA256 mismatch for $url"
    mv -f "$file.$$.part" "$file"
  fi
  echo "$file"
}
unpack() {
  local name=$1 archive dir digest
  archive=$(download "$name"); digest=$(sha256 "$archive")
  dir="$work/src/$name-${digest:0:16}"
  if [[ ! -f "$dir/.source-ready" ]]; then
    mkdir -p "$dir"
    tar -xf "$archive" -C "$dir" --strip-components=1
    touch "$dir/.source-ready"
  fi
  echo "$dir"
}
# The source/config/compiler stamp invalidates dependency builds when inputs change.
stamp=$work/toolchain.txt
{ cat "$here/sources.tsv" "$here/components.txt" "$here/build.sh"; echo "$target $CC $CXX $CFLAGS $CXXFLAGS $LDFLAGS"; "$CC" --version; } > "$stamp"
fingerprint=$(sha256 "$stamp")
fingerprint=${fingerprint:0:16}
build_dependency() {
  local name=$1 src dir
  shift
  [[ -f "$prefix/.$name-$fingerprint" ]] && return
  src=$(unpack "$name"); dir="$work/build/$name-$fingerprint"
  mkdir -p "$dir"
  (
    cd "$dir"
    if [[ "$name" == zlib ]]; then
      if [[ "$platform" == win ]]; then
        cp -R "$src/." "$dir/"
        make -f win32/Makefile.gcc -j"$JOBS" CC="$CC" AR="$AR" RC=windres libz.a
        mkdir -p "$prefix/include" "$prefix/lib" "$prefix/lib/pkgconfig"
        cp libz.a "$prefix/lib/"
        cp zlib.h zconf.h "$prefix/include/"
        sed -e "s|@prefix@|$prefix|g" -e 's|@exec_prefix@|${prefix}|g' \
          -e 's|@libdir@|${exec_prefix}/lib|g' -e 's|@sharedlibdir@|${libdir}|g' \
          -e 's|@includedir@|${prefix}/include|g' -e "s|@VERSION@|$(source_field zlib 2)|g" \
          zlib.pc.in > "$prefix/lib/pkgconfig/zlib.pc"
      else
        "$src/configure" --prefix="$prefix" --static
        make -j"$JOBS"
        make install
      fi
    else
      "$src/configure" --prefix="$prefix" --disable-shared --enable-static --with-pic "$@"
      make -j"$JOBS"
      make install
    fi
  )
  touch "$prefix/.$name-$fingerprint"
}
deps_kind=pinned-static
if [[ -n "$reuse_build" ]]; then
  [[ -z "$deps_override" ]] || die '--reuse-build cannot be combined with --deps-prefix'
  reuse_build=$(cd "$reuse_build" && pwd)
  "$NODE" "$(node_path "$here/libav-cache.mjs")" verify "$target" "$(node_path "$reuse_build")" "$(node_path "$work/reused-libav-cache.json")"
  prefix=$reuse_build/prefix
  ffmpeg_prefix=$reuse_build/libav
  cached_build=$("$NODE" -p 'require(process.argv[1]).ffmpegBuildDirectory' "$(node_path "$reuse_build/libav-cache.json")")
  ffmpeg_build=$reuse_build/$cached_build
  deps_kind=$("$NODE" -p 'require(process.argv[1]).dependencies' "$(node_path "$reuse_build/libav-cache.json")")
else
if [[ -n "$deps_override" ]]; then
  prefix=$(cd "$deps_override" && pwd)
  export PKG_CONFIG_LIBDIR="$prefix/lib/pkgconfig"
  deps_kind=local-override
else
  build_dependency zlib
  build_dependency lame --disable-frontend --disable-decoder --disable-asm
  build_dependency opencore-amr --disable-examples
  build_dependency speex --disable-binaries --disable-examples --disable-oggtest
  build_dependency ogg
  build_dependency vorbis --disable-examples --disable-oggtest
fi
source_hash=$("$NODE" -p 'require(process.argv[1]).sourceTreeSha256' "$(node_path "$here/ffmpeg-source.json")")
short_source_hash=${source_hash:0:16}
ffmpeg_src=$work/src/ffmpeg-$short_source_hash
"$NODE" "$(node_path "$here/prepare-source.mjs")" "$(node_path "$ffmpeg_src")"
cp "$here/ffmpeg-source.json" "$work/ffmpeg-source.json"
cp "$here/components.txt" "$work/components.txt"
ffmpeg_prefix=$work/libav
ffmpeg_build=$work/build/ffmpeg-$short_source_hash-$fingerprint
mkdir -p "$ffmpeg_build"
ffmpeg_flags=()
while IFS= read -r flag || [[ -n "$flag" ]]; do ffmpeg_flags+=("$flag"); done < "$work/components.txt"
ffmpeg_flags+=(--prefix="$ffmpeg_prefix" --cc="$CC" --cxx="$CXX" --ar="$AR" --ranlib="$RANLIB"
  --pkg-config-flags=--static --extra-cflags="$CFLAGS -I$prefix/include" --extra-ldflags="$LDFLAGS -L$prefix/lib")
case "$platform" in
  win) ffmpeg_flags+=(--target-os=mingw32 --arch=x86_64 --enable-w32threads --disable-pthreads --extra-ldflags="-static $LDFLAGS -L$prefix/lib") ;;
  macos) ffmpeg_flags+=(--target-os=darwin --arch=arm64 --enable-pthreads) ;;
  linux) ffmpeg_flags+=(--enable-pthreads) ;;
esac
(
  cd "$ffmpeg_build"
  "$ffmpeg_src/configure" "${ffmpeg_flags[@]}"
  make -j"$JOBS"
  make install
)
fi
cp "$here/ffmpeg-source.json" "$work/ffmpeg-source.json"
cp "$here/components.txt" "$work/components.txt"
silk_prefix=$work/silk/install
bash "$here/build-silk.sh" "$work/silk" "$silk_prefix"
cp "$work/silk/silk-source.json" "$work/silk-source.json"
cp "$work/silk/silk-build.json" "$work/silk-build.json"
node_headers=${NODE_HEADERS:-$(unpack node-headers)/include/node}
[[ -f "$node_headers/node_api.h" ]] || die "node_api.h missing from $node_headers"
export PKG_CONFIG_LIBDIR="$ffmpeg_prefix/lib/pkgconfig:$prefix/lib/pkgconfig"
read -r -a av_cflags <<< "$(pkg-config --cflags libavformat libavcodec libavutil libswresample libswscale)"
read -r -a av_libs <<< "$(pkg-config --static --libs libavformat libavcodec libavutil libswresample libswscale)"
read -r -a cxx_flags <<< "$CXXFLAGS"
read -r -a ld_flags <<< "$LDFLAGS"
cp "$here/addon.cc" "$work/addon.cc"
sha256 "$work/addon.cc" > "$work/addon-source-sha256.txt"
"$CXX" -std=c++17 -DNAPI_VERSION=8 -DNODE_GYP_MODULE_NAME=luckylillia_ffmpeg -O2 -fPIC "${cxx_flags[@]}" "${av_cflags[@]}" \
  -I"$node_headers" -I"$silk_prefix/include" -c "$work/addon.cc" -o "$work/addon.o"
link_flags=(-shared)
case "$platform" in
  win) node_lib=${NODE_LIB:-$(download node-lib)}; link_flags+=(-static -static-libgcc -static-libstdc++ "$node_lib" -Wl,--enable-auto-import) ;;
  macos) link_flags=(-bundle -undefined dynamic_lookup) ;;
  linux) link_flags+=(-static-libgcc -static-libstdc++ -Wl,-z,relro,-z,now) ;;
esac
filename=LuckyLillia.FFmpeg.node
"$CXX" "$work/addon.o" "${link_flags[@]}" "${ld_flags[@]}" "${av_libs[@]}" "$silk_prefix/lib/libSKP_SILK_SDK.a" -lm -o "$output/$filename"
cmp "$here/addon.cc" "$work/addon.cc"
if [[ "$platform" == macos ]]; then "$STRIP" -x "$output/$filename"; else "$STRIP" --strip-unneeded "$output/$filename"; fi
case "$platform" in
  win)
    objdump -p "$output/$filename" | awk '/DLL Name:/ {print $3}' > "$work/dynamic-libraries.txt"
    if grep -Ei '(^lib|avcodec|avformat|avutil|swresample|swscale|zlib)' "$work/dynamic-libraries.txt"; then die 'Unexpected DLL dependency'; fi ;;
  macos)
    otool -L "$output/$filename" | tail -n +2 > "$work/dynamic-libraries.txt"
    if grep -Ev '^[[:space:]]*(/usr/lib/|/System/Library/)' "$work/dynamic-libraries.txt"; then die 'Unexpected dynamic dependency'; fi ;;
  linux)
    readelf -d "$output/$filename" | sed -n 's/.*Shared library: \[\(.*\)\]/\1/p' > "$work/dynamic-libraries.txt"
    if grep -Ev '^(libc\.so(\.6)?|libm\.so\.6|libpthread\.so\.0|libdl\.so\.2|librt\.so\.1|ld-linux[^/]*|libc\.musl-[^/]+\.so\.1)$' "$work/dynamic-libraries.txt"; then die 'Unexpected dynamic dependency'; fi ;;
esac
SILK_LIBRARY="$(node_path "$silk_prefix/lib/libSKP_SILK_SDK.a")" FFMPEG_COMPILER="$("$CXX" --version | head -n 1)" FFMPEG_DEPS_KIND="$deps_kind" \
"$NODE" "$(node_path "$here/write-build.mjs")" "$target" "$(node_path "$output")" "$(node_path "$work")"
# Preserve materials for static LGPL relinking as a separate release artifact.
relink=$work/relink
mkdir -p "$relink/lib" "$relink/source"
cp "$work/addon.o" "$relink/"
cp "$ffmpeg_prefix/lib/"*.a "$relink/lib/"
cp "$silk_prefix/lib/libSKP_SILK_SDK.a" "$relink/lib/"
cp "$here/silk-source.json" "$here/prepare-silk.mjs" "$here/build-silk.sh" "$here/write-silk-build.mjs" "$here/silk.mk" "$work/silk-build.json" "$relink/source/"
cp "$work/silk/toolchain.txt" "$relink/source/silk-toolchain.txt"
mkdir -p "$relink/source/silk-sdk"
cp -R "$work/silk/source/." "$relink/source/silk-sdk/"
if [[ -f "$work/reused-libav-cache.json" ]]; then cp "$work/reused-libav-cache.json" "$relink/"; fi
for lib in libz.a libmp3lame.a libopencore-amrnb.a libopencore-amrwb.a libspeex.a libogg.a libvorbis.a libvorbisenc.a; do cp "$prefix/lib/$lib" "$relink/lib/"; done
cp "$work/addon.cc" "$here/build.sh" "$work/components.txt" "$here/sources.tsv" "$here/README.md" "$work/ffmpeg-source.json" "$here/prepare-source.mjs" "$relink/source/"
cp "$here/write-build.mjs" "$here/libav-cache.mjs" "$relink/source/"
mkdir -p "$relink/licenses"
cp "$here/licenses/"*.txt "$relink/licenses/"
cp "$ffmpeg_build/config.h" "$ffmpeg_build/ffbuild/config.mak" "$output/build.json" "$relink/"
printf '%q ' "$CXX" "$work/addon.o" "${link_flags[@]}" "${ld_flags[@]}" "${av_libs[@]}" "$silk_prefix/lib/libSKP_SILK_SDK.a" -lm > "$relink/original-link-command.txt"
tar -czf "$work/ffmpeg-relink-$target.tar.gz" -C "$relink" .
if [[ -z "$reuse_build$deps_override" ]]; then
  "$NODE" "$(node_path "$here/libav-cache.mjs")" capture "$target" "$(node_path "$work")" "$(node_path "$ffmpeg_build")" "$(node_path "$output/build.json")"
fi
echo "Built $output/$filename ($(sha256 "$output/$filename"))"

#!/usr/bin/env bash
# Shared environment for the tested Zig 0.14.1 Linux-host cross recipes.
set -euo pipefail
cross_here=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
repo=$(cd -- "$cross_here/.." && pwd)
base=${FFMPEG_CROSS_WORK:-$repo/output/ffmpeg-cross-build}
downloads=${FFMPEG_DOWNLOADS:-$repo/output/ffmpeg-downloads}
export ZIG=${ZIG:-zig}
export JOBS=${JOBS:-6}
[[ "$(uname -s)" == Linux && "$(uname -m)" == x86_64 ]] || { echo 'Run these cross recipes on Linux x64 (WSL is supported)' >&2; exit 1; }
ZIG=$(command -v "$ZIG")
[[ "$("$ZIG" version)" == 0.14.1 ]] || { echo 'Zig 0.14.1 is required' >&2; exit 1; }
export ZIG
LLVM_NM=${LLVM_NM:-$(command -v llvm-nm || command -v llvm-nm-18)}
LLVM_OBJDUMP=${LLVM_OBJDUMP:-$(command -v llvm-objdump || command -v llvm-objdump-18)}
export LLVM_NM LLVM_OBJDUMP
mkdir -p "$base" "$downloads"
base=$(cd "$base" && pwd); downloads=$(cd "$downloads" && pwd)
custom_sha=$(node -p 'require(process.argv[1]).sourceTreeSha256' "$repo/ffmpeg-source.json")
source_tree=$base/ffmpeg-${custom_sha:0:16}
[[ "$base$downloads" != *' '* ]] || { echo 'Build paths cannot contain spaces' >&2; exit 1; }
download_source() {
  local name=$1 expected url archive
  expected=$(awk -v name="$name" '$1 == name {print $3}' "$repo/sources.tsv")
  url=$(awk -v name="$name" '$1 == name {print $4}' "$repo/sources.tsv")
  [[ "$expected" =~ ^[0-9a-f]{64}$ ]] || { echo "Missing source pin: $name" >&2; exit 1; }
  archive="$downloads/${url##*/}"
  if [[ ! -f "$archive" ]] || [[ "$(sha256sum "$archive" | cut -d' ' -f1)" != "$expected" ]]; then
    curl --fail --location --retry 3 "$url" -o "$archive.$$.part"
    [[ "$(sha256sum "$archive.$$.part" | cut -d' ' -f1)" == "$expected" ]] || { echo "Source hash mismatch: $name" >&2; exit 1; }
    mv "$archive.$$.part" "$archive"
  fi
}

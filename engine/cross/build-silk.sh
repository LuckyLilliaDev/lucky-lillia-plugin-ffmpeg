#!/usr/bin/env bash
set -euo pipefail
target=$1
source "$(dirname -- "$0")/env.sh"
work="$base/$target"
export CC="$work/bin/cc" AR="$work/bin/ar" RANLIB="$work/bin/ranlib" CFLAGS='-O2 -fPIC'
export SILK_COMPILER_VERSION="Zig $("$ZIG" version), target $target"
[[ -x "$CC" && -x "$AR" && -x "$RANLIB" ]] || { echo 'Prepare the target compiler wrappers with cross/build-deps.sh first' >&2; exit 1; }
bash "$repo/build-silk.sh" "$work/silk" "$work/install"
cp "$work/silk/silk-source.json" "$work/silk-source.json"
cp "$work/silk/silk-build.json" "$work/silk-build.json"

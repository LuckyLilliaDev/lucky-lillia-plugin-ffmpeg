#!/usr/bin/env bash
set -euo pipefail
here=$(cd -- "$(dirname -- "$0")" && pwd)
[[ $# == 2 ]] || { echo 'Usage: build-silk.sh WORK PREFIX (CC AR RANLIB CFLAGS NODE JOBS in environment)' >&2; exit 1; }
mkdir -p "$1" "$2/lib" "$2/include"
work=$(cd "$1" && pwd)
prefix=$(cd "$2" && pwd)
[[ "$here$work$prefix" != *' '* ]] || { echo 'SILK build paths cannot contain spaces' >&2; exit 1; }
NODE=${NODE:-node}
CC=${CC:-gcc}; AR=${AR:-ar}; RANLIB=${RANLIB:-ranlib}; JOBS=${JOBS:-4}
node_path() { case "$(uname -s)" in MINGW*|MSYS*) cygpath -m "$1" ;; *) printf '%s\n' "$1" ;; esac; }
"$NODE" "$(node_path "$here/prepare-silk.mjs")" "$(node_path "$work/source")"
cp "$here/silk-source.json" "$work/silk-source.json"
{
  cat "$work/silk-source.json" "$here/build-silk.sh" "$here/silk.mk"
  printf '%s\n' "$CC $AR $RANLIB ${CFLAGS:-}"
  if [[ -n "${SILK_COMPILER_VERSION:-}" ]]; then printf '%s\n' "$SILK_COMPILER_VERSION"; cat "$CC"; else "$CC" --version; fi
} > "$work/toolchain.txt"
fingerprint=$("$NODE" -e 'const fs=require("fs"),c=require("crypto");process.stdout.write(c.createHash("sha256").update(fs.readFileSync(process.argv[1])).digest("hex"))' "$(node_path "$work/toolchain.txt")")
objects="$work/objects-${fingerprint:0:16}"
mkdir -p "$objects"
make -f "$here/silk.mk" -j"$JOBS" SILK_SOURCE="$work/source" SILK_OBJECTS="$objects" CC="$CC" AR="$AR" RANLIB="$RANLIB" CFLAGS="${CFLAGS:-}"
cp "$objects/libSKP_SILK_SDK.a" "$prefix/lib/"
cp "$work/source/silk/interface/"*.h "$prefix/include/"
cp "$work/source/silk/src/"*.h "$prefix/include/"
cmp "$work/silk-source.json" "$here/silk-source.json"
"$NODE" "$(node_path "$here/write-silk-build.mjs")" "$(node_path "$work")" "$(node_path "$prefix")" "$fingerprint"

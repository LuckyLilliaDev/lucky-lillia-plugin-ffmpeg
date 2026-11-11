#!/usr/bin/env bash
set -eu
source "$(dirname -- "$0")/env.sh"
node "$repo/prepare-source.mjs" "$source_tree"
chmod +x "$source_tree/configure" "$source_tree/ffbuild/"*.sh
printf 'Verified submodule source ready: %s\n' "$source_tree"

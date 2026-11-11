#!/usr/bin/env python3
import os, sys
zig = os.environ['ZIG']
args = []
for arg in sys.argv[1:]:
    if arg == '-Wl,-dynamic,-search_paths_first':
        continue
    args.append(arg)
os.execv(zig, [zig, 'cc', '-target', 'aarch64-macos.11.0', *args])

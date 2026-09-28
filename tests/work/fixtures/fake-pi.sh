#!/bin/sh
# Stand-in for pi in tests/work/tmux-integration.test.mjs: records which session file it was asked to open, then idles.
if [ "$1" = "--session" ]; then : > "$2.opened"; fi
exec sleep 30

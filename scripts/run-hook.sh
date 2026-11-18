#!/usr/bin/env sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
LOCAL_PLUG_MARKER="../../../.agents/plugins/fons/hooks.json"
REL_INBOX="../../fons/ideas.md"

if [ -f "$LOCAL_PLUG_MARKER" ] && [ ! -s "$REL_INBOX" ]; then
  if [ "${1:-}" = "Stop" ]; then
    printf '%s\n' '{"decision":"allow"}'
  else
    printf '%s\n' '{}'
  fi
  exit 0
fi

exec node "$SCRIPT_DIR/fons-hook.mjs"

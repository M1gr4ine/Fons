#!/usr/bin/env sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
LOCAL_PLUG_MARKER="../../../.agents/plugins/fons/hooks.json"
REL_FONS="../../fons"

if [ -f "$LOCAL_PLUG_MARKER" ] && [ "${1:-}" != "SessionStart" ]; then
  for file in "$REL_FONS"/ideas-*.md "$REL_FONS"/ideas.md; do
    if [ -s "$file" ]; then exec node "$SCRIPT_DIR/fons-hook.mjs" --scope=workspace; fi
  done
  if [ "${1:-}" = "PreInvocation" ]; then
    for file in "$REL_FONS"/.retract-*.pending; do
      if [ -f "$file" ]; then exec node "$SCRIPT_DIR/fons-hook.mjs" --scope=workspace; fi
    done
  fi
  if [ "${1:-}" = "Stop" ]; then
    printf '%s\n' '{"decision":"allow"}'
  else
    printf '%s\n' '{}'
  fi
  exit 0
fi

exec node "$SCRIPT_DIR/fons-hook.mjs" --scope=workspace
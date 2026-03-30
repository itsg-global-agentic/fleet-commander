#!/bin/sh
# fleet-commander v0.0.13
# Fleet Commander hook: PreCompact
# Fires when context window is about to be compacted.
# This is a leading indicator of context pressure — the agent is running
# a complex/long task that is filling the context window.
# stdin JSON example: {"session_id":"abc123"}

HOOK_DIR="$(cd "$(dirname "$0")" && pwd)"
_LOG="${FLEET_HOOK_LOG:-/tmp/fleet-hooks.log}"
echo "$(date -u +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || echo unknown) | HOOK  | pre_compact | ${FLEET_TEAM_ID:-?} | cwd=$(pwd)" >> "$_LOG" 2>/dev/null || true
input=$(cat)
echo "$input" | "$HOOK_DIR/send_event.sh" "pre_compact"
exit 0

#!/bin/sh
# fleet-commander v0.0.23
# Fleet Commander hook: Stop
# Fires when the main agent stops — could mean task complete, error, or stuck.
# stdin JSON example: {"session_id":"abc123","stop_reason":"end_turn"}

HOOK_DIR="$(cd "$(dirname "$0")" && pwd)"
_LOG="${FLEET_HOOK_LOG:-/tmp/fleet-hooks.log}"
echo "$(date -u +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || echo unknown) | HOOK  | stop | ${FLEET_TEAM_ID:-?} | cwd=$(pwd)" >> "$_LOG" 2>/dev/null || true
input=$(cat)
echo "$input" | "$HOOK_DIR/send_event.sh" "stop"
exit 0

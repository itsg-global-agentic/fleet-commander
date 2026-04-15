#!/bin/sh
# fleet-commander v0.0.23
# Fleet Commander hook: SessionEnd
# Detects team finish. Clean shutdown signal.
# stdin JSON example: {"session_id":"abc123"}

HOOK_DIR="$(cd "$(dirname "$0")" && pwd)"
_LOG="${FLEET_HOOK_LOG:-/tmp/fleet-hooks.log}"
echo "$(date -u +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || echo unknown) | HOOK  | session_end | ${FLEET_TEAM_ID:-?} | cwd=$(pwd)" >> "$_LOG" 2>/dev/null || true
input=$(cat)
echo "$input" | "$HOOK_DIR/send_event.sh" "session_end"
exit 0

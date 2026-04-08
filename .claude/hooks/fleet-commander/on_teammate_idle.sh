#!/bin/sh
# fleet-commander v0.0.20
# Fleet Commander hook: TeammateIdle
# Fires when a subagent goes idle. Provides explicit per-subagent idle tracking.
# stdin JSON example: {"session_id":"abc123","teammate_name":"csharp-dev"}

HOOK_DIR="$(cd "$(dirname "$0")" && pwd)"
_LOG="${FLEET_HOOK_LOG:-/tmp/fleet-hooks.log}"
echo "$(date -u +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || echo unknown) | HOOK  | teammate_idle | ${FLEET_TEAM_ID:-?} | cwd=$(pwd)" >> "$_LOG" 2>/dev/null || true
input=$(cat)
echo "$input" | "$HOOK_DIR/send_event.sh" "teammate_idle"
exit 0

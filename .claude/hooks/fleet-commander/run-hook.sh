#!/bin/bash
# fleet-commander v0.0.19
# Universal hook wrapper — logs ENTER layer before executing the real hook.
# Usage: run-hook.sh <event_type> <script_name>
# Called from settings.json hook commands.

HOOK_DIR="$(cd "$(dirname "$0")" && pwd)"
EVENT_TYPE="${1:-unknown}"
SCRIPT="${2:-}"
_LOG="${FLEET_HOOK_LOG:-/tmp/fleet-hooks.log}"

echo "$(date -u +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || echo unknown) | ENTER | $EVENT_TYPE | ${FLEET_TEAM_ID:-?} | pid=$$ script=$SCRIPT" >> "$_LOG" 2>/dev/null || true

# Execute the actual hook script, forwarding stdin
exec "$HOOK_DIR/$SCRIPT"

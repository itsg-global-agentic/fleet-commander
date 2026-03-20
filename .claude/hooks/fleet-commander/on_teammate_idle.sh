#!/bin/sh
# Fleet Commander hook: TeammateIdle
# Fires when a subagent goes idle. Provides explicit per-subagent idle tracking.
# stdin JSON example: {"session_id":"abc123","teammate_name":"csharp-dev"}

HOOK_DIR="$(cd "$(dirname "$0")" && pwd)"
input=$(cat)
echo "$input" | "$HOOK_DIR/send_event.sh" "teammate_idle"

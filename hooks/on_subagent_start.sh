#!/bin/sh
# Fleet Commander hook: SubagentStart
# Tracks internal team agent spawn (e.g., kea-csharp-dev joining the team).
# stdin JSON example: {"session_id":"abc123","teammate_name":"csharp-dev","agent_type":"kea-csharp-dev"}

HOOK_DIR="$(cd "$(dirname "$0")" && pwd)"
input=$(cat)
echo "$input" | "$HOOK_DIR/send_event.sh" "subagent_start" &

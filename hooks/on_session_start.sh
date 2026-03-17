#!/bin/sh
# Fleet Commander hook: SessionStart
# Detects team startup. Captures session_id, worktree, model info.
# stdin JSON example: {"session_id":"abc123","agent_type":"main"}

HOOK_DIR="$(cd "$(dirname "$0")" && pwd)"
input=$(cat)
echo "$input" | "$HOOK_DIR/send_event.sh" "session_start"

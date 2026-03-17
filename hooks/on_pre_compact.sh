#!/bin/sh
# Fleet Commander hook: PreCompact
# Fires when context window is about to be compacted.
# This is a leading indicator of context pressure — the agent is running
# a complex/long task that is filling the context window.
# stdin JSON example: {"session_id":"abc123"}

HOOK_DIR="$(cd "$(dirname "$0")" && pwd)"
input=$(cat)
echo "$input" | "$HOOK_DIR/send_event.sh" "pre_compact"

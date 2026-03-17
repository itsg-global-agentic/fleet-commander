#!/bin/sh
# Fleet Commander hook: Notification
# Detects idle prompts, permission prompts, and other notifications.
# These are important for detecting teams that are stuck waiting for input.
# stdin JSON example: {"session_id":"abc123","message":"Permission requested..."}

HOOK_DIR="$(cd "$(dirname "$0")" && pwd)"
input=$(cat)
echo "$input" | "$HOOK_DIR/send_event.sh" "notification"

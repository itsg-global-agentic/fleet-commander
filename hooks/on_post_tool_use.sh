#!/bin/sh
# fleet-commander v0.0.20
# Fleet Commander hook: PostToolUse
# THE primary heartbeat signal. Every tool use proves the team is alive.
# Dashboard uses this to compute "last_seen" for stuck detection.
# stdin JSON example: {"session_id":"abc123","tool_name":"Bash","agent_type":"main"}

HOOK_DIR="$(cd "$(dirname "$0")" && pwd)"
_LOG="${FLEET_HOOK_LOG:-/tmp/fleet-hooks.log}"
echo "$(date -u +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || echo unknown) | HOOK  | tool_use | ${FLEET_TEAM_ID:-?} | cwd=$(pwd)" >> "$_LOG" 2>/dev/null || true
input=$(cat)
echo "$input" | "$HOOK_DIR/send_event.sh" "tool_use"

# ── Handoff file detection ───────────────────────────────────────
# If the tool was Write or Edit and the file is plan.md, changes.md, or
# review.md, capture the file content and send a handoff_file event.
# Runs in background so the hook returns immediately (fire-and-forget).
TOOL_NAME=""
FILE_PATH=""

# Try jq first for reliable extraction, fallback to grep/sed for Windows Git Bash
if command -v jq >/dev/null 2>&1; then
    TOOL_NAME=$(printf '%s' "$input" | jq -r '.tool_name // empty' 2>/dev/null || true)
    FILE_PATH=$(printf '%s' "$input" | jq -r '.tool_input.file_path // .tool_input.path // empty' 2>/dev/null || true)
else
    # grep/sed fallback — handles "tool_name":"Write" and nested "file_path":"..."
    TOOL_NAME=$(printf '%s' "$input" | grep -o '"tool_name":"[^"]*"' | head -1 | sed 's/"tool_name":"//;s/"$//' || true)
    FILE_PATH=$(printf '%s' "$input" | grep -o '"file_path":"[^"]*"' | head -1 | sed 's/"file_path":"//;s/"$//' || true)
fi

echo "$(date -u +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || echo unknown) | PARSE | tool_use | ${FLEET_TEAM_ID:-?} | tool_name=$TOOL_NAME file_path=$FILE_PATH" >> "$_LOG" 2>/dev/null || true

# Check if this is a Write or Edit of a handoff file
if [ -n "$TOOL_NAME" ] && [ -n "$FILE_PATH" ]; then
    case "$TOOL_NAME" in
        Write|Edit)
            BASENAME=$(basename "$FILE_PATH" 2>/dev/null || true)
            case "$BASENAME" in
                plan.md|changes.md|review.md)
                    echo "$(date -u +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || echo unknown) | HAND  | tool_use | ${FLEET_TEAM_ID:-?} | file=$BASENAME exists=$([ -f "$FILE_PATH" ] && echo yes || echo no)" >> "$_LOG" 2>/dev/null || true
                    "$HOOK_DIR/send_handoff.sh" "$BASENAME" "$FILE_PATH" "$input" &
                    ;;
            esac
            ;;
    esac
fi

exit 0

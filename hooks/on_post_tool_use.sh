#!/bin/sh
# fleet-commander v0.0.23
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
# review.md, snapshot the file synchronously (before backgrounding) and
# pass the snapshot path to send_handoff.sh.
#
# Why a synchronous snapshot? The TL routinely deletes plan.md / changes.md /
# review.md from the worktree right after a subagent finishes. If we just
# backgrounded send_handoff.sh and let it read $FILE_PATH later, the TL
# would win the race and the upload would silently fail (file not found).
# By copying to a temp file in the foreground, we capture the content
# atomically — even if the worktree file is deleted before curl runs.
TOOL_NAME=""
FILE_PATH=""
AGENT_NAME=""

# Try jq first for reliable extraction, fallback to grep/sed for Windows Git Bash
if command -v jq >/dev/null 2>&1; then
    TOOL_NAME=$(printf '%s' "$input" | jq -r '.tool_name // empty' 2>/dev/null || true)
    FILE_PATH=$(printf '%s' "$input" | jq -r '.tool_input.file_path // .tool_input.path // empty' 2>/dev/null || true)
    AGENT_NAME=$(printf '%s' "$input" | jq -r '.agent_type // .teammate_name // empty' 2>/dev/null || true)
else
    # grep/sed fallback — handles "tool_name":"Write" and nested "file_path":"..."
    TOOL_NAME=$(printf '%s' "$input" | grep -o '"tool_name":"[^"]*"' | head -1 | sed 's/"tool_name":"//;s/"$//' || true)
    FILE_PATH=$(printf '%s' "$input" | grep -o '"file_path":"[^"]*"' | head -1 | sed 's/"file_path":"//;s/"$//' || true)
    AGENT_NAME=$(printf '%s' "$input" | grep -o '"agent_type":"[^"]*"' | head -1 | sed 's/"agent_type":"//;s/"$//' || true)
    if [ -z "$AGENT_NAME" ]; then
        AGENT_NAME=$(printf '%s' "$input" | grep -o '"teammate_name":"[^"]*"' | head -1 | sed 's/"teammate_name":"//;s/"$//' || true)
    fi
fi

echo "$(date -u +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || echo unknown) | PARSE | tool_use | ${FLEET_TEAM_ID:-?} | tool_name=$TOOL_NAME file_path=$FILE_PATH agent=$AGENT_NAME" >> "$_LOG" 2>/dev/null || true

# Check if this is a Write or Edit of a handoff file
if [ -n "$TOOL_NAME" ] && [ -n "$FILE_PATH" ]; then
    case "$TOOL_NAME" in
        Write|Edit)
            BASENAME=$(basename "$FILE_PATH" 2>/dev/null || true)
            case "$BASENAME" in
                plan.md|changes.md|review.md)
                    if [ -f "$FILE_PATH" ]; then
                        # Snapshot synchronously — produces a temp copy that
                        # send_handoff.sh will upload and then unlink. The
                        # 50KB cap is enforced at the snapshot stage to
                        # match the server-side cap and avoid wasting disk.
                        SNAPSHOT=""
                        SNAPSHOT=$(mktemp 2>/dev/null || echo "/tmp/fleet-handoff-snapshot-$$-$BASENAME")
                        if head -c 51200 "$FILE_PATH" > "$SNAPSHOT" 2>/dev/null; then
                            SNAP_SIZE=$(wc -c < "$SNAPSHOT" 2>/dev/null || echo 0)
                            echo "$(date -u +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || echo unknown) | HAND  | tool_use | ${FLEET_TEAM_ID:-?} | file=$BASENAME snapshot=$SNAPSHOT size=${SNAP_SIZE}b" >> "$_LOG" 2>/dev/null || true
                            FLEET_HANDOFF_SNAPSHOT=1 "$HOOK_DIR/send_handoff.sh" "$BASENAME" "$SNAPSHOT" "" "$AGENT_NAME" &
                        else
                            # Snapshot failed (no mktemp/head, full disk, etc.) — fall back
                            # to direct-path upload so the original behavior is preserved.
                            rm -f "$SNAPSHOT" 2>/dev/null || true
                            echo "$(date -u +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || echo unknown) | HAND  | tool_use | ${FLEET_TEAM_ID:-?} | file=$BASENAME snapshot=fallback" >> "$_LOG" 2>/dev/null || true
                            "$HOOK_DIR/send_handoff.sh" "$BASENAME" "$FILE_PATH" "" "$AGENT_NAME" &
                        fi
                    else
                        echo "$(date -u +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || echo unknown) | HAND  | tool_use | ${FLEET_TEAM_ID:-?} | file=$BASENAME exists=no" >> "$_LOG" 2>/dev/null || true
                    fi
                    ;;
            esac
            ;;
    esac
fi

exit 0

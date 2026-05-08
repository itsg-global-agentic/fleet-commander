#!/bin/sh
# fleet-commander v0.0.23
# Fleet Commander hook: SubagentStop
# Tracks internal team agent departure.
# stdin JSON example: {"session_id":"abc123","teammate_name":"csharp-dev","agent_type":"kea-csharp-dev"}

HOOK_DIR="$(cd "$(dirname "$0")" && pwd)"
_LOG="${FLEET_HOOK_LOG:-/tmp/fleet-hooks.log}"
echo "$(date -u +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || echo unknown) | HOOK  | subagent_stop | ${FLEET_TEAM_ID:-?} | cwd=$(pwd)" >> "$_LOG" 2>/dev/null || true
input=$(cat)
echo "$input" | "$HOOK_DIR/send_event.sh" "subagent_stop"

# ── Capture handoff files after subagent exits ────────────────────
# Subagent Write calls don't trigger PostToolUse on the parent process,
# so we check for handoff files here instead. Only send the file that
# matches the agent type to avoid duplicate sends.
WORKTREE_ROOT="$(pwd)"
AGENT_NAME=""
if command -v jq >/dev/null 2>&1; then
    AGENT_NAME=$(printf '%s' "$input" | jq -r '.agent_type // .teammate_name // empty' 2>/dev/null || true)
else
    # Fallback: extract agent_type with grep/sed (no jq on Windows Git Bash)
    AGENT_NAME=$(printf '%s' "$input" | grep -o '"agent_type":"[^"]*"' | head -1 | sed 's/"agent_type":"//;s/"$//' || true)
    if [ -z "$AGENT_NAME" ]; then
        AGENT_NAME=$(printf '%s' "$input" | grep -o '"teammate_name":"[^"]*"' | head -1 | sed 's/"teammate_name":"//;s/"$//' || true)
    fi
fi

echo "$(date -u +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || echo unknown) | PARSE | subagent_stop | ${FLEET_TEAM_ID:-?} | agent_name=$AGENT_NAME" >> "$_LOG" 2>/dev/null || true

case "$AGENT_NAME" in
    *planner*) HANDOFF_FILE="plan.md" ;;
    *dev*)     HANDOFF_FILE="changes.md" ;;
    *review*)  HANDOFF_FILE="review.md" ;;
    *)         HANDOFF_FILE="" ;;
esac

if [ -n "$HANDOFF_FILE" ]; then
    FULL_PATH="$WORKTREE_ROOT/$HANDOFF_FILE"
    FILE_EXISTS=$([ -f "$FULL_PATH" ] && echo yes || echo no)
    echo "$(date -u +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || echo unknown) | HAND  | subagent_stop | ${FLEET_TEAM_ID:-?} | file=$HANDOFF_FILE exists=$FILE_EXISTS cwd=$WORKTREE_ROOT" >> "$_LOG" 2>/dev/null || true
    if [ "$FILE_EXISTS" = "yes" ]; then
        # Snapshot synchronously (see on_post_tool_use.sh for rationale) so the
        # TL deleting plan.md/changes.md/review.md before the backgrounded
        # upload reads it does not silently drop the capture.
        SNAPSHOT=""
        SNAPSHOT=$(mktemp 2>/dev/null || echo "/tmp/fleet-handoff-snapshot-$$-$HANDOFF_FILE")
        if head -c 51200 "$FULL_PATH" > "$SNAPSHOT" 2>/dev/null; then
            SNAP_SIZE=$(wc -c < "$SNAPSHOT" 2>/dev/null || echo 0)
            echo "$(date -u +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || echo unknown) | HAND  | subagent_stop | ${FLEET_TEAM_ID:-?} | file=$HANDOFF_FILE snapshot=$SNAPSHOT size=${SNAP_SIZE}b" >> "$_LOG" 2>/dev/null || true
            FLEET_HANDOFF_SNAPSHOT=1 "$HOOK_DIR/send_handoff.sh" "$HANDOFF_FILE" "$SNAPSHOT" "$input" "$AGENT_NAME" &
        else
            # Snapshot failed — fall back to direct-path upload.
            rm -f "$SNAPSHOT" 2>/dev/null || true
            echo "$(date -u +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || echo unknown) | HAND  | subagent_stop | ${FLEET_TEAM_ID:-?} | file=$HANDOFF_FILE snapshot=fallback" >> "$_LOG" 2>/dev/null || true
            "$HOOK_DIR/send_handoff.sh" "$HANDOFF_FILE" "$FULL_PATH" "$input" "$AGENT_NAME" &
        fi
    fi
else
    echo "$(date -u +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || echo unknown) | HAND  | subagent_stop | ${FLEET_TEAM_ID:-?} | no handoff match for agent_name=$AGENT_NAME" >> "$_LOG" 2>/dev/null || true
fi

exit 0

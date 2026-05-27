#!/bin/bash
# fleet-commander v0.0.26
# Fleet Commander: Sends a handoff file (plan.md, changes.md, review.md)
# to the Fleet Commander server via multipart form upload.
#
# Two invocation modes:
#
#   1. Snapshot mode (preferred — race-free):
#      send_handoff.sh --snapshot <file_type> <snapshot_path> <original_path> [<cc_stdin_json>]
#      The caller has ALREADY copied the file content to <snapshot_path>
#      synchronously (foreground). This script uploads from the snapshot
#      and then deletes it. <original_path> is for logging only.
#
#   2. Legacy mode (kept for backwards compat / external callers):
#      send_handoff.sh <file_type> <file_path> [<cc_stdin_json>]
#      The script reads <file_path> directly. Subject to the deletion
#      race that motivates issue #708.
#
# Optional environment:
#   AGENT_NAME — when set, forwarded as the multipart `agentName` field
#                so the server can record which subagent produced the file.
#
# Called from on_post_tool_use.sh and on_subagent_stop.sh in background
# (fire-and-forget). POSTs as multipart form to /api/handoff.
#
# Design principles:
#   - NEVER block Claude Code. Timeout is 10 seconds, errors are swallowed.
#   - Content capped at 50KB (head -c 51200) to prevent DB bloat.
#   - Always exits 0 — failures must not propagate.
#   - Uses multipart form upload — zero JSON encoding in bash.

# ── Configuration ──────────────────────────────────────────────────
FLEET_URL="${FLEET_SERVER_URL:-http://localhost:4680}/api/handoff"
# Strip any trailing /api/events suffix from FLEET_SERVER_URL (callers
# may have the old events URL configured) and replace with /api/handoff.
FLEET_URL=$(printf '%s' "$FLEET_URL" | sed 's|/api/events$||; s|/api/handoff$||')
FLEET_URL="${FLEET_URL}/api/handoff"

# Logging
_LOG="${FLEET_HOOK_LOG:-/tmp/fleet-hooks.log}"

# Kill switch
if [ "${FLEET_COMMANDER_OFF:-0}" = "1" ]; then
    exit 0
fi

# ── Parse args: detect --snapshot mode ─────────────────────────────
SNAPSHOT_MODE=0
SNAP_PATH=""
ORIG_PATH=""

if [ "${1:-}" = "--snapshot" ]; then
    SNAPSHOT_MODE=1
    FILE_TYPE="${2:-}"
    SNAP_PATH="${3:-}"
    ORIG_PATH="${4:-}"
    # $5 (cc_stdin_json) accepted for backward compat but no longer used.
else
    FILE_TYPE="${1:-}"
    SNAP_PATH="${2:-}"
    ORIG_PATH="${2:-}"
    # $3 (cc_stdin_json) accepted for backward compat but no longer used.
fi

# Validate inputs
if [ -z "$FILE_TYPE" ] || [ -z "$SNAP_PATH" ]; then
    echo "$(date -u +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || echo unknown) | ERROR | handoff_file | ${FLEET_TEAM_ID:-?} | missing file_type or file_path" >> "$_LOG" 2>/dev/null || true
    exit 0
fi

# ── Resolve UPLOAD_PATH ──────────────────────────────────────────
# In snapshot mode, the caller already capped+copied the content.
# In legacy mode, we may need to cap it ourselves.
UPLOAD_PATH=""
TMPFILE=""

if [ "$SNAPSHOT_MODE" -eq 1 ]; then
    # Snapshot path is the source of truth — no re-validation against the
    # live file (which may already be deleted by the TL).
    SNAP_SIZE=0
    if [ -f "$SNAP_PATH" ]; then
        SNAP_SIZE=$(wc -c < "$SNAP_PATH" 2>/dev/null || echo 0)
    fi
    echo "$(date -u +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || echo unknown) | ENTER | handoff_file | ${FLEET_TEAM_ID:-?} | type=$FILE_TYPE snapshot=$SNAP_PATH size=${SNAP_SIZE}b orig=$ORIG_PATH" >> "$_LOG" 2>/dev/null || true

    if [ ! -s "$SNAP_PATH" ]; then
        echo "$(date -u +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || echo unknown) | ERROR | handoff_file | ${FLEET_TEAM_ID:-?} | snapshot empty or missing: $SNAP_PATH" >> "$_LOG" 2>/dev/null || true
        rm -f "$SNAP_PATH" 2>/dev/null || true
        exit 0
    fi

    UPLOAD_PATH="$SNAP_PATH"
else
    # Legacy mode: re-implement the original read+cap logic.
    FILE_PATH="$SNAP_PATH"
    FILE_SIZE=0
    if [ -f "$FILE_PATH" ]; then
        FILE_SIZE=$(wc -c < "$FILE_PATH" 2>/dev/null || echo 0)
    fi
    echo "$(date -u +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || echo unknown) | ENTER | handoff_file | ${FLEET_TEAM_ID:-?} | type=$FILE_TYPE path=$FILE_PATH size=${FILE_SIZE}b" >> "$_LOG" 2>/dev/null || true

    if [ ! -f "$FILE_PATH" ]; then
        echo "$(date -u +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || echo unknown) | ERROR | handoff_file | ${FLEET_TEAM_ID:-?} | file not found: $FILE_PATH" >> "$_LOG" 2>/dev/null || true
        exit 0
    fi

    # Verify file has content
    CONTENT_CHECK=$(head -c 1 "$FILE_PATH" 2>/dev/null || true)
    if [ -z "$CONTENT_CHECK" ]; then
        echo "$(date -u +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || echo unknown) | ERROR | handoff_file | ${FLEET_TEAM_ID:-?} | file empty: $FILE_PATH" >> "$_LOG" 2>/dev/null || true
        exit 0
    fi

    # Cap file at 50KB using a temp file (curl -F reads from disk)
    if [ "$FILE_SIZE" -gt 51200 ] 2>/dev/null; then
        TMPFILE=$(mktemp 2>/dev/null || echo "/tmp/fleet-handoff-$$")
        head -c 51200 "$FILE_PATH" > "$TMPFILE" 2>/dev/null
        UPLOAD_PATH="$TMPFILE"
    else
        UPLOAD_PATH="$FILE_PATH"
    fi
fi

echo "$(date -u +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || echo unknown) | HOOK  | handoff_file | ${FLEET_TEAM_ID:-?} | upload=$UPLOAD_PATH ($(wc -c < "$UPLOAD_PATH" 2>/dev/null || echo '?')b)" >> "$_LOG" 2>/dev/null || true

# ── Identify worktree / team ─────────────────────────────────────
TEAM_NAME=""

if [ -n "${FLEET_TEAM_ID:-}" ]; then
    TEAM_NAME="$FLEET_TEAM_ID"
fi

if [ -z "$TEAM_NAME" ] && [ -n "${CLAUDE_PROJECT_DIR:-}" ]; then
    case "$CLAUDE_PROJECT_DIR" in
        */worktrees/*)
            TEAM_NAME=$(printf '%s' "$CLAUDE_PROJECT_DIR" | sed 's|.*/worktrees/||' | sed 's|/.*||')
            ;;
        *)
            TEAM_NAME=$(basename "$CLAUDE_PROJECT_DIR")
            ;;
    esac
fi

if [ -z "$TEAM_NAME" ]; then
    WORKTREE_ROOT=$(git rev-parse --show-toplevel 2>/dev/null || pwd)
    case "$WORKTREE_ROOT" in
        */worktrees/*)
            TEAM_NAME=$(printf '%s' "$WORKTREE_ROOT" | sed 's|.*/worktrees/||' | sed 's|/.*||')
            ;;
        *)
            TEAM_NAME=$(basename "$WORKTREE_ROOT")
            ;;
    esac
fi

echo "$(date -u +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || echo unknown) | HOOK  | handoff_file | ${FLEET_TEAM_ID:-$TEAM_NAME} | team=$TEAM_NAME url=$FLEET_URL agent=${AGENT_NAME:-}" >> "$_LOG" 2>/dev/null || true

# ── Fire and forget (multipart form upload) ──────────────────────
if command -v curl >/dev/null 2>&1; then
    # Build curl args: include agentName form field only when AGENT_NAME is set
    if [ -n "${AGENT_NAME:-}" ]; then
        curl -s -S --max-time 10 --connect-timeout 2 \
            -X POST \
            -F "team=${TEAM_NAME}" \
            -F "fileType=${FILE_TYPE}" \
            -F "agentName=${AGENT_NAME}" \
            -F "file=@${UPLOAD_PATH}" \
            "$FLEET_URL" >/dev/null 2>&1
        CURL_RESULT=$?
    else
        curl -s -S --max-time 10 --connect-timeout 2 \
            -X POST \
            -F "team=${TEAM_NAME}" \
            -F "fileType=${FILE_TYPE}" \
            -F "file=@${UPLOAD_PATH}" \
            "$FLEET_URL" >/dev/null 2>&1
        CURL_RESULT=$?
    fi
    if [ "$CURL_RESULT" -eq 0 ]; then
        echo "$(date -u +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || echo unknown) | SEND  | handoff_file | $TEAM_NAME | type=$FILE_TYPE curl=ok" >> "$_LOG" 2>/dev/null || true
    else
        echo "$(date -u +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || echo unknown) | SEND  | handoff_file | $TEAM_NAME | type=$FILE_TYPE curl=fail($CURL_RESULT)" >> "$_LOG" 2>/dev/null || true
    fi
else
    echo "$(date -u +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || echo unknown) | SEND  | handoff_file | $TEAM_NAME | type=$FILE_TYPE curl=missing" >> "$_LOG" 2>/dev/null || true
fi

# Clean up snapshot (snapshot mode) and any legacy temp file
if [ "$SNAPSHOT_MODE" -eq 1 ] && [ -n "$SNAP_PATH" ] && [ -f "$SNAP_PATH" ]; then
    rm -f "$SNAP_PATH" 2>/dev/null || true
fi
if [ -n "$TMPFILE" ] && [ -f "$TMPFILE" ]; then
    rm -f "$TMPFILE" 2>/dev/null || true
fi

# Always exit 0 — hooks must never fail
exit 0

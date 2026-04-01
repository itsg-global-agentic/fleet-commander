#!/bin/bash
# fleet-commander v0.0.17
# Fleet Commander: Sends a handoff_file event when an agent writes
# plan.md, changes.md, or review.md.
#
# Usage: send_handoff.sh <file_type> <file_path> <cc_stdin_json>
#
# Called from on_post_tool_use.sh in background (fire-and-forget).
# Reads the file content (capped at 50KB) and POSTs a handoff_file
# event to the Fleet Commander server.
#
# Design principles:
#   - NEVER block Claude Code. Timeout is 2 seconds, errors are swallowed.
#   - Content capped at 50KB (head -c 51200) to prevent DB bloat.
#   - Always exits 0 — failures must not propagate.

# ── Configuration ──────────────────────────────────────────────────
FLEET_URL="${FLEET_SERVER_URL:-http://localhost:4680/api/events}"
FILE_TYPE="${1:-}"
FILE_PATH="${2:-}"
CC_STDIN="${3:-}"

# Logging
_LOG="${FLEET_HOOK_LOG:-/tmp/fleet-hooks.log}"

# Kill switch
if [ "${FLEET_COMMANDER_OFF:-0}" = "1" ]; then
    exit 0
fi

# Validate inputs
if [ -z "$FILE_TYPE" ] || [ -z "$FILE_PATH" ]; then
    echo "$(date -u +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || echo unknown) | ERROR | handoff_file | ${FLEET_TEAM_ID:-?} | missing file_type or file_path" >> "$_LOG" 2>/dev/null || true
    exit 0
fi

# ── Read file content (capped at 50KB) ───────────────────────────
FILE_SIZE=0
if [ -f "$FILE_PATH" ]; then
    FILE_SIZE=$(wc -c < "$FILE_PATH" 2>/dev/null || echo 0)
fi
echo "$(date -u +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || echo unknown) | ENTER | handoff_file | ${FLEET_TEAM_ID:-?} | type=$FILE_TYPE path=$FILE_PATH size=${FILE_SIZE}b" >> "$_LOG" 2>/dev/null || true

if [ ! -f "$FILE_PATH" ]; then
    echo "$(date -u +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || echo unknown) | ERROR | handoff_file | ${FLEET_TEAM_ID:-?} | file not found: $FILE_PATH" >> "$_LOG" 2>/dev/null || true
    exit 0
fi

CONTENT=$(head -c 51200 "$FILE_PATH" 2>/dev/null || true)
if [ -z "$CONTENT" ]; then
    echo "$(date -u +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || echo unknown) | ERROR | handoff_file | ${FLEET_TEAM_ID:-?} | file empty: $FILE_PATH" >> "$_LOG" 2>/dev/null || true
    exit 0
fi
CONTENT_LEN=${#CONTENT}
echo "$(date -u +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || echo unknown) | HOOK  | handoff_file | ${FLEET_TEAM_ID:-?} | read ${CONTENT_LEN}b from $FILE_PATH" >> "$_LOG" 2>/dev/null || true

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

# ── Build timestamp ───────────────────────────────────────────────
TIMESTAMP=$(date -u +"%Y-%m-%dT%H:%M:%SZ" 2>/dev/null || date +"%Y-%m-%dT%H:%M:%SZ" 2>/dev/null || echo "unknown")

# ── JSON string encoder ──────────────────────────────────────────
json_encode_string() {
    if command -v jq >/dev/null 2>&1; then
        jq -Rs .
    else
        local raw
        raw="$(cat; printf .)"
        raw="${raw%.}"
        printf '%s' "$raw" | tr '\015' '\001' | awk '
        BEGIN { ORS=""; printf "\"" }
        {
            gsub(/\\/, "\\\\")
            gsub(/"/, "\\\"")
            gsub(/\t/, "\\t")
            gsub(/\001/, "\\r")
            gsub(/\x08/, "\\b")
            gsub(/\x0c/, "\\f")
            if (NR > 1) printf "\\n"
            printf "%s", $0
        }
        END { printf "\"" }
        '
    fi
}

# ── Compose JSON payload ─────────────────────────────────────────
# Build a cc_stdin-style payload with file_type and content fields
# so the server can extract them via JSON.parse().
ENCODED_CONTENT=$(printf '%s' "$CONTENT" | json_encode_string)
ENCODED_FILE_TYPE=$(printf '%s' "$FILE_TYPE" | json_encode_string)
ENCODED_TEAM=$(printf '%s' "$TEAM_NAME" | json_encode_string)
ENCODED_TIMESTAMP=$(printf '%s' "$TIMESTAMP" | json_encode_string)

# Build inner cc_stdin object with file_type and content
CC_STDIN_OBJ="{\"file_type\":${ENCODED_FILE_TYPE},\"content\":${ENCODED_CONTENT}}"
ENCODED_CC_STDIN=$(printf '%s' "$CC_STDIN_OBJ" | json_encode_string)

PAYLOAD="{\"event\":\"handoff_file\",\"team\":${ENCODED_TEAM},\"timestamp\":${ENCODED_TIMESTAMP},\"cc_stdin\":${ENCODED_CC_STDIN}}"

# ── Fire and forget ───────────────────────────────────────────────
if command -v curl >/dev/null 2>&1; then
    curl -s -S --max-time 2 --connect-timeout 1 \
        -X POST \
        -H "Content-Type: application/json" \
        -d "$PAYLOAD" \
        "$FLEET_URL" >/dev/null 2>&1
    CURL_RESULT=$?
    if [ "$CURL_RESULT" -eq 0 ]; then
        echo "$(date -u +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || echo unknown) | SEND  | handoff_file | $TEAM_NAME | type=$FILE_TYPE curl=ok" >> "$_LOG" 2>/dev/null || true
    else
        echo "$(date -u +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || echo unknown) | SEND  | handoff_file | $TEAM_NAME | type=$FILE_TYPE curl=fail($CURL_RESULT)" >> "$_LOG" 2>/dev/null || true
    fi
else
    echo "$(date -u +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || echo unknown) | SEND  | handoff_file | $TEAM_NAME | type=$FILE_TYPE curl=missing" >> "$_LOG" 2>/dev/null || true
fi

# Always exit 0 — hooks must never fail
exit 0

#!/bin/bash
# Fleet Commander: Universal event sender for Claude Code hooks.
# POSTs a JSON event to the Fleet Commander dashboard server.
#
# Usage: echo '{"hook_input": ...}' | send_event.sh <event_type>
#   or:  send_event.sh <event_type>  (no stdin — sends minimal event)
#
# Environment:
#   FLEET_SERVER_URL     — dashboard endpoint (default: http://localhost:4680/api/events)
#   FLEET_COMMANDER_OFF  — set to "1" to disable all reporting (silent no-op)
#
# Design principles:
#   - NEVER block Claude Code. Timeout is 2 seconds, errors are swallowed.
#   - Runs in the worktree directory — extracts team name from path.
#   - Reads hook stdin JSON to extract session_id, tool_name, etc.

# ── Configuration ──────────────────────────────────────────────────
FLEET_URL="${FLEET_SERVER_URL:-http://localhost:4680/api/events}"
EVENT_TYPE="${1:-unknown}"

# Kill switch
if [ "${FLEET_COMMANDER_OFF:-0}" = "1" ]; then
    exit 0
fi

# ── Read stdin (if any) ───────────────────────────────────────────
# Hooks receive JSON on stdin. We capture it, but if stdin is empty
# or a TTY we proceed with an empty object.
STDIN_JSON=""
if [ ! -t 0 ]; then
    STDIN_JSON=$(cat 2>/dev/null || true)
fi
[ -z "$STDIN_JSON" ] && STDIN_JSON="{}"

# ── Identify worktree / team ─────────────────────────────────────
# Hooks run with CWD inside the worktree. We derive the team name
# from the directory path.
#
# Pattern: .claude/worktrees/kea-NNN  →  team = "kea-NNN"
# Fallback: basename of git toplevel  →  team = "itsg-kea" (main repo)
WORKTREE_ROOT=$(git rev-parse --show-toplevel 2>/dev/null || pwd)

# Try to extract team name from worktree path
TEAM_NAME=""
case "$WORKTREE_ROOT" in
    */worktrees/*)
        # Extract the last path component after "worktrees/"
        TEAM_NAME=$(printf '%s' "$WORKTREE_ROOT" | sed 's|.*/worktrees/||' | sed 's|/.*||')
        ;;
    *)
        TEAM_NAME=$(basename "$WORKTREE_ROOT")
        ;;
esac

# Allow explicit override via environment variable
TEAM_NAME="${FLEET_TEAM_ID:-${CLAUDE_WORKTREE_NAME:-$TEAM_NAME}}"

# ── Extract fields from hook stdin JSON ───────────────────────────
# We use grep+sed for POSIX portability (no jq dependency).
extract_json_string() {
    local field="$1"
    printf '%s' "$STDIN_JSON" | grep -o "\"${field}\"[[:space:]]*:[[:space:]]*\"[^\"]*\"" | head -1 | sed "s/.*:[[:space:]]*\"//;s/\"$//"
}

extract_json_value() {
    local field="$1"
    printf '%s' "$STDIN_JSON" | grep -o "\"${field}\"[[:space:]]*:[[:space:]]*[^,}]*" | head -1 | sed "s/.*:[[:space:]]*//" | sed 's/[[:space:]]*$//'
}

SESSION_ID=$(extract_json_string "session_id")
TOOL_NAME=$(extract_json_string "tool_name")
AGENT_TYPE=$(extract_json_string "agent_type")
TEAMMATE_NAME=$(extract_json_string "teammate_name")
MESSAGE=$(extract_json_string "message")
ERROR=$(extract_json_string "error")
TOOL_USE_ID=$(extract_json_string "tool_use_id")
STOP_REASON=$(extract_json_string "stop_reason")
ERROR_DETAILS=$(extract_json_string "error_details")
LAST_ASSISTANT_MESSAGE=$(extract_json_string "last_assistant_message")

# ── Extract SendMessage routing fields from tool_input ────────────
# When tool_name is "SendMessage", the hook stdin contains a tool_input
# object with "to" and optional "summary" fields. We extract these for
# inter-agent message routing. Silent failure on parse errors.
MSG_TO=""
MSG_SUMMARY=""
if [ "$TOOL_NAME" = "SendMessage" ]; then
    # tool_input is a nested JSON object; extract "to" and "summary" from it
    TOOL_INPUT=$(printf '%s' "$STDIN_JSON" | grep -o '"tool_input"[[:space:]]*:[[:space:]]*{[^}]*}' | head -1 | sed 's/^"tool_input"[[:space:]]*:[[:space:]]*//')
    if [ -n "$TOOL_INPUT" ]; then
        MSG_TO=$(printf '%s' "$TOOL_INPUT" | grep -o '"to"[[:space:]]*:[[:space:]]*"[^"]*"' | head -1 | sed 's/.*:[[:space:]]*"//;s/"$//')
        MSG_SUMMARY=$(printf '%s' "$TOOL_INPUT" | grep -o '"summary"[[:space:]]*:[[:space:]]*"[^"]*"' | head -1 | sed 's/.*:[[:space:]]*"//;s/"$//')
    fi
fi

# ── Build timestamp ───────────────────────────────────────────────
TIMESTAMP=$(date -u +"%Y-%m-%dT%H:%M:%SZ" 2>/dev/null || date +"%Y-%m-%dT%H:%M:%SZ" 2>/dev/null || echo "unknown")

# ── Compose JSON payload ─────────────────────────────────────────
# We build JSON manually to avoid jq dependency.
# Fields with empty values are omitted.

json_field() {
    local key="$1" val="$2"
    [ -z "$val" ] && return
    # Escape backslashes first, then double quotes
    val=$(printf '%s' "$val" | sed 's|\\|\\\\|g; s|"|\\"|g')
    printf '"%s":"%s",' "$key" "$val"
}

json_field_raw() {
    local key="$1" val="$2"
    [ -z "$val" ] && return
    printf '"%s":%s,' "$key" "$val"
}

PAYLOAD="{"
PAYLOAD="${PAYLOAD}$(json_field "event" "$EVENT_TYPE")"
PAYLOAD="${PAYLOAD}$(json_field "team" "$TEAM_NAME")"
PAYLOAD="${PAYLOAD}$(json_field "timestamp" "$TIMESTAMP")"
PAYLOAD="${PAYLOAD}$(json_field "session_id" "$SESSION_ID")"
PAYLOAD="${PAYLOAD}$(json_field "tool_name" "$TOOL_NAME")"
PAYLOAD="${PAYLOAD}$(json_field "agent_type" "$AGENT_TYPE")"
PAYLOAD="${PAYLOAD}$(json_field "teammate_name" "$TEAMMATE_NAME")"
PAYLOAD="${PAYLOAD}$(json_field "message" "$MESSAGE")"
PAYLOAD="${PAYLOAD}$(json_field "error" "$ERROR")"
PAYLOAD="${PAYLOAD}$(json_field "tool_use_id" "$TOOL_USE_ID")"
PAYLOAD="${PAYLOAD}$(json_field "stop_reason" "$STOP_REASON")"
PAYLOAD="${PAYLOAD}$(json_field "error_details" "$ERROR_DETAILS")"
PAYLOAD="${PAYLOAD}$(json_field "last_assistant_message" "$LAST_ASSISTANT_MESSAGE")"
PAYLOAD="${PAYLOAD}$(json_field "worktree_root" "$WORKTREE_ROOT")"
PAYLOAD="${PAYLOAD}$(json_field "msg_to" "$MSG_TO")"
PAYLOAD="${PAYLOAD}$(json_field "msg_summary" "$MSG_SUMMARY")"
# Remove trailing comma, close brace
PAYLOAD=$(printf '%s' "$PAYLOAD" | sed 's/,$//')
PAYLOAD="${PAYLOAD}}"

# ── Fire and forget ───────────────────────────────────────────────
# curl with 2-second timeout. Errors are silenced completely.
# The hook MUST NOT block Claude Code or cause visible failures.
if command -v curl >/dev/null 2>&1; then
    curl -s -S --max-time 2 --connect-timeout 1 \
        -X POST \
        -H "Content-Type: application/json" \
        -d "$PAYLOAD" \
        "$FLEET_URL" >/dev/null 2>&1
fi

# Always exit 0 — hooks must never fail
exit 0

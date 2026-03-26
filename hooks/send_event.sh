#!/bin/bash
# fleet-commander v0.0.10
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
#   - Forwards raw CC stdin JSON to the server as a single "cc_stdin" field.
#     All field extraction (session_id, tool_name, tool_input, etc.) is done
#     server-side where JSON.parse is available, eliminating shell regex fragility.

# ── Configuration ──────────────────────────────────────────────────
FLEET_URL="${FLEET_SERVER_URL:-http://localhost:4680/api/events}"
EVENT_TYPE="${1:-unknown}"

# Kill switch
if [ "${FLEET_COMMANDER_OFF:-0}" = "1" ]; then
    exit 0
fi

# ── Read stdin (if any) ───────────────────────────────────────────
# Hooks receive JSON on stdin. We capture the raw string to forward
# to the server. If stdin is empty or a TTY we leave it blank.
STDIN_JSON=""
if [ ! -t 0 ]; then
    STDIN_JSON=$(cat 2>/dev/null || true)
fi

# ── Identify worktree / team ─────────────────────────────────────
# Priority:
#   1. FLEET_TEAM_ID env var (set by team-manager.ts spawn env)
#   2. CLAUDE_PROJECT_DIR env var (set by CC >= 1.0.58 for hooks)
#   3. git rev-parse --show-toplevel (legacy fallback)
#
# Pattern: .claude/worktrees/kea-NNN  →  team = "kea-NNN"
# Fallback: basename of project dir   →  team = "itsg-kea" (main repo)

TEAM_NAME=""

# Try FLEET_TEAM_ID first (set by FC spawn environment)
if [ -n "${FLEET_TEAM_ID:-}" ]; then
    TEAM_NAME="$FLEET_TEAM_ID"
fi

# Try CLAUDE_PROJECT_DIR (CC sets this for hook commands since v1.0.58)
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

# Fallback: git toplevel
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

# ── Compose JSON payload ─────────────────────────────────────────
# Shell only adds three fields it knows: event, team, timestamp.
# The raw CC stdin JSON is forwarded as the "cc_stdin" string field.
# All field extraction happens server-side via JSON.parse().

# ── JSON string encoder ────────────────────────────────────────
# Reads raw text from stdin, outputs a valid JSON string WITH
# surrounding double quotes. Handles all RFC 8259 control chars.
# Uses jq when available; falls back to awk for portability.
json_encode_string() {
    if command -v jq >/dev/null 2>&1; then
        jq -Rs .
    else
        # Pure-shell fallback using awk for reliable multi-line processing.
        # tr replaces \r with \x01 sentinel because gawk on Windows strips
        # \r during record splitting before gsub can see it.
        local raw
        raw="$(cat; printf .)"   # printf . preserves trailing newlines
        raw="${raw%.}"            # strip sentinel
        printf '%s' "$raw" | tr '\015' '\001' | awk '
        BEGIN { ORS=""; printf "\"" }
        {
            gsub(/\\/, "\\\\")       # backslashes first
            gsub(/"/, "\\\"")        # double quotes
            gsub(/\t/, "\\t")        # tabs
            gsub(/\001/, "\\r")      # carriage returns (from sentinel)
            gsub(/\x08/, "\\b")      # backspace
            gsub(/\x0c/, "\\f")      # form feed
            if (NR > 1) printf "\\n" # newlines between lines
            printf "%s", $0
        }
        END { printf "\"" }
        '
    fi
}

json_field() {
    local key="$1" val="$2"
    [ -z "$val" ] && return
    local encoded
    encoded=$(printf '%s' "$val" | json_encode_string)
    printf '"%s":%s,' "$key" "$encoded"
}

PAYLOAD="{"
PAYLOAD="${PAYLOAD}$(json_field "event" "$EVENT_TYPE")"
PAYLOAD="${PAYLOAD}$(json_field "team" "$TEAM_NAME")"
PAYLOAD="${PAYLOAD}$(json_field "timestamp" "$TIMESTAMP")"
if [ -n "$STDIN_JSON" ] && [ "$STDIN_JSON" != "{}" ]; then
    ENCODED=$(printf '%s' "$STDIN_JSON" | json_encode_string)
    PAYLOAD="${PAYLOAD}\"cc_stdin\":${ENCODED},"
fi
# Remove trailing comma, close brace
PAYLOAD=$(printf '%s' "$PAYLOAD" | sed 's/,$//')
PAYLOAD="${PAYLOAD}}"

# ── Fire and forget ───────────────────────────────────────────────
# curl with 2-second timeout. Errors are silenced completely.
# The hook MUST NOT block Claude Code or cause visible failures.
_LOG="${FLEET_HOOK_LOG:-/tmp/fleet-hooks.log}"
if command -v curl >/dev/null 2>&1; then
    curl -s -S --max-time 2 --connect-timeout 1 \
        -X POST \
        -H "Content-Type: application/json" \
        -d "$PAYLOAD" \
        "$FLEET_URL" >/dev/null 2>&1
    CURL_RESULT=$?
    if [ "$CURL_RESULT" -eq 0 ]; then
        echo "$(date -u +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || echo unknown) | SEND  | $EVENT_TYPE | $TEAM_NAME | curl=ok" >> "$_LOG" 2>/dev/null || true
    else
        echo "$(date -u +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || echo unknown) | SEND  | $EVENT_TYPE | $TEAM_NAME | curl=fail($CURL_RESULT)" >> "$_LOG" 2>/dev/null || true
    fi
else
    echo "$(date -u +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || echo unknown) | SEND  | $EVENT_TYPE | $TEAM_NAME | curl=missing" >> "$_LOG" 2>/dev/null || true
fi

# Always exit 0 — hooks must never fail
exit 0

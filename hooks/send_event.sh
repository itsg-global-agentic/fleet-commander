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

# ── Build timestamp ───────────────────────────────────────────────
TIMESTAMP=$(date -u +"%Y-%m-%dT%H:%M:%SZ" 2>/dev/null || date +"%Y-%m-%dT%H:%M:%SZ" 2>/dev/null || echo "unknown")

# ── Compose JSON payload ─────────────────────────────────────────
# Shell only adds three fields it knows: event, team, timestamp.
# The raw CC stdin JSON is forwarded as the "cc_stdin" string field.
# All field extraction happens server-side via JSON.parse().

json_field() {
    local key="$1" val="$2"
    [ -z "$val" ] && return
    # Escape backslashes first, then double quotes
    val=$(printf '%s' "$val" | sed 's|\\|\\\\|g; s|"|\\"|g')
    printf '"%s":"%s",' "$key" "$val"
}

PAYLOAD="{"
PAYLOAD="${PAYLOAD}$(json_field "event" "$EVENT_TYPE")"
PAYLOAD="${PAYLOAD}$(json_field "team" "$TEAM_NAME")"
PAYLOAD="${PAYLOAD}$(json_field "timestamp" "$TIMESTAMP")"
if [ -n "$STDIN_JSON" ] && [ "$STDIN_JSON" != "{}" ]; then
    # Escape the raw JSON string for embedding inside a JSON string value.
    # This handles backslashes, double quotes, and control characters.
    ESCAPED=$(printf '%s' "$STDIN_JSON" | sed 's|\\|\\\\|g; s|"|\\"|g' | tr '\n' ' ' | tr '\r' ' ' | tr '\t' ' ')
    PAYLOAD="${PAYLOAD}\"cc_stdin\":\"${ESCAPED}\","
fi
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

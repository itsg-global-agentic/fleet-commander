# Claude Fleet Commander: Hook-Based Event Tracking System

## Architecture Overview

```
                    +-----------------+
                    |  Fleet Commander |
                    |    Dashboard     |
                    |  (localhost:4680)|
                    +--------^--------+
                             |
                    HTTP POST /api/events
                             |
        +--------------------+--------------------+
        |                    |                    |
  +-----------+        +-----------+        +-----------+
  | Worktree  |        | Worktree  |        | Worktree  |
  | kea-777   |        | kea-778   |        | kea-779   |
  | (Issue #777)       | (Issue #778)       | (Issue #779)
  +-----------+        +-----------+        +-----------+
  | Hooks:    |        | Hooks:    |        | Hooks:    |
  | - session |        | - session |        | - session |
  | - tool_use|        | - tool_use|        | - tool_use|
  | - stop    |        | - stop    |        | - stop    |
  | - errors  |        | - errors  |        | - errors  |
  +-----------+        +-----------+        +-----------+
```

Each Claude Code instance runs in its own worktree. Hooks fire automatically
on lifecycle events and POST structured JSON to the dashboard server. The
dashboard never asks agents anything — it only receives events and polls
GitHub separately for PR/CI status.

---

## 1. Hook Selection and Rationale

### 1.1 SessionStart

**Why:** The birth event. When a team launches (`claude --worktree kea-NNN`),
this hook fires, telling the dashboard "team kea-NNN is alive." Captures
session_id and worktree path — the two identifiers that tie all subsequent
events together.

**Signal value:** Team exists and has started. Dashboard creates a new row
in the fleet table.

### 1.2 SessionEnd

**Why:** The clean death event. When a session terminates normally, this
fires. The dashboard marks the team as "completed" and stops expecting
heartbeats.

**Signal value:** Distinguishes clean exit from crash/stuck. If the dashboard
sees heartbeats stop WITHOUT a SessionEnd, the team crashed.

### 1.3 Stop

**Why:** Fires when the main agent stops producing output. This could mean:
- Task is done (normal)
- Agent is stuck waiting for something
- Agent hit an error it cannot recover from

**Signal value:** A "soft stop" that may or may not be followed by more
activity. Dashboard tracks stop frequency — many stops in quick succession
indicates thrashing.

### 1.4 StopFailure

**Why:** Fires when the agent stops due to rate limits, API errors, or other
infrastructure failures. Unlike a normal Stop, StopFailure indicates the
agent was forcibly halted by external constraints rather than completing its
turn. Without this hook, rate limits and API errors are invisible to Fleet
Commander — the dashboard only sees silence until the stuck detector fires.

**Signal value:** Immediate visibility into infrastructure problems:
- Rate limit hit → team cannot make progress until the limit resets
- API error → potential outage or configuration issue
- The dashboard can surface `error_details` and `last_assistant_message` so
  the PM knows exactly why the agent stopped and what it was doing.

### 1.5 SubagentStart / SubagentStop

**Why:** The KEA team has 8 agent types (coordinator, analityk, csharp-dev,
fsharp-dev, ts-dev, devops-dev, weryfikator, pr-watcher). Tracking their
lifecycle lets the dashboard show exactly which agents are active within
each team.

**Signal value:**
- SubagentStart with `teammate_name: "pr-watcher"` → team is in PR/CI phase
- SubagentStart with `teammate_name: "fsharp-dev"` → team needs F# work
- SubagentStop with `teammate_name: "weryfikator"` → review phase complete

### 1.6 Notification

**Why:** Catches idle prompts ("Your teammate is waiting") and permission
prompts. Both indicate the team is paused waiting for external input.

**Signal value:** If a team accumulates notifications without tool_use
events, it is stuck waiting. The dashboard can flag "needs human attention."

### 1.7 PreCompact

**Why:** Context compaction means the agent is running out of context window
space. This is an early warning that the task is complex/long-running and
the agent may lose context of earlier work.

**Signal value:** Leading indicator of complexity. Multiple PreCompact events
for one team → the task might need to be broken down.

### 1.8 PostToolUse (heartbeat)

**Why:** This is THE primary activity signal. Every time any tool completes
(Bash, Read, Write, Edit, Grep, etc.), this hook fires. It proves the agent
is alive and working.

**Signal value:** The dashboard's "last_seen" timestamp comes from this hook.
It also captures WHICH tool was used, enabling activity profiling:
- Lots of `Read` + `Grep` → agent is in analysis phase
- Lots of `Edit` + `Write` → agent is implementing
- Lots of `Bash` → agent is testing/building

### 1.9 PostToolUseFailure

**Why:** Tool errors (build failures, test failures, permission errors) are
the strongest signal that a team is struggling. A burst of errors means the
agent is retrying something that keeps failing.

**Signal value:** Error rate tracking. Dashboard can compute:
- errors_per_minute > threshold → team is flailing
- Specific tool_name in errors → "Build is broken" vs "Tests failing"

### 1.10 TeammateIdle

**Why:** Fires when a specific subagent goes idle. Unlike the dashboard's
timer-based idle detection (which operates at the team level), this hook
provides an explicit per-subagent idle signal directly from Claude Code.
CC provides `session_id`, `teammate_name`, and `team_name`.

**Signal value:** Per-subagent granularity on idle status:
- TeammateIdle with `teammate_name: "dev"` → developer agent is waiting
- Combined with SubagentStart/SubagentStop → full subagent activity timeline
- Complements the dashboard's stuck detector with explicit CC-side idle signals

FC's hook is a pure observer (exit 0, empty stdout) and coexists safely
with domain-specific TeammateIdle hooks (e.g., pr-watcher-idle.sh) via
the array syntax.

---

## 2. Hook Script Design

### 2.1 Single sender: `send_event.sh`

All hook wrapper scripts pipe their stdin JSON to `send_event.sh`, which:

1. Reads the hook's stdin JSON (contains session_id, tool_name, etc.)
2. Detects the worktree/team name from the current directory
3. Adds a timestamp
4. Builds a JSON payload
5. POSTs to the dashboard via `curl` with 2-second timeout
6. Runs the curl in the background (`&`) so it never blocks
7. Always exits 0

Key design decisions:
- **Uses `jq` for JSON encoding when available; falls back to awk for
  environments without `jq`.** No hard dependency on `jq`.
- **No Python dependency.** Pure shell.
- **Fire and forget.** The curl runs backgrounded. If the server is down,
  the event is simply lost (acceptable — see section 6).
- **2-second timeout.** curl's `--max-time 2 --connect-timeout 1` ensures
  the hook returns fast even if the network is slow.

### 2.2 JSON Payload Format

Every event follows this schema:

```json
{
  "event": "tool_use",
  "team": "kea-777",
  "timestamp": "2026-03-16T14:30:45Z",
  "session_id": "sess_abc123",
  "tool_name": "Bash",
  "agent_type": "main",
  "teammate_name": "csharp-dev",
  "message": "",
  "stop_reason": "",
  "worktree_root": "/c/Git/itsg-kea/.claude/worktrees/kea-777"
}
```

Fields are omitted when empty. Per-event payloads:

| Event            | Key fields populated                                   |
|------------------|--------------------------------------------------------|
| session_start    | team, session_id, agent_type                           |
| session_end      | team, session_id                                       |
| stop             | team, session_id, stop_reason                          |
| stop_failure     | team, session_id, error_details, last_assistant_message|
| subagent_start   | team, session_id, teammate_name, agent_type            |
| subagent_stop    | team, session_id, teammate_name, agent_type            |
| notification     | team, session_id, message                              |
| pre_compact      | team, session_id                                       |
| tool_use         | team, session_id, tool_name, agent_type                |
| tool_error       | team, session_id, tool_name, message                   |
| teammate_idle    | team, session_id, teammate_name                        |

### 2.3 Wrapper Scripts

Each hook event has a thin wrapper that:
1. Captures stdin
2. Pipes it to `send_event.sh` with the event type as argument

Example (`on_post_tool_use.sh`):
```sh
#!/bin/sh
HOOK_DIR="$(cd "$(dirname "$0")" && pwd)"
input=$(cat)
echo "$input" | "$HOOK_DIR/send_event.sh" "tool_use"
```

Why separate scripts per event instead of one script with conditionals?
- Claude Code's `settings.json` maps each hook type to a specific command
- Each command path is the wiring point
- Thin wrappers are easier to debug individually

---

## 3. Worktree Identification

### 3.1 How hooks know which team they belong to

Hooks run with CWD set to the project/worktree directory. The identification
chain:

```
CWD (where hook runs)
  → git rev-parse --show-toplevel
  → /c/Git/itsg-kea/.claude/worktrees/kea-777
  → extract "kea-777" via path parsing
  → team = "kea-777"
```

### 3.2 Path parsing logic

```sh
WORKTREE_ROOT=$(git rev-parse --show-toplevel 2>/dev/null || pwd)

case "$WORKTREE_ROOT" in
    */worktrees/*)
        # Inside a managed worktree: extract team name
        TEAM_NAME=$(printf '%s' "$WORKTREE_ROOT" | sed 's|.*/worktrees/||' | sed 's|/.*||')
        ;;
    *)
        # Main repo (TL agent running from the root)
        TEAM_NAME=$(basename "$WORKTREE_ROOT")
        ;;
esac
```

### 3.3 Main repo vs worktree

When the TL (Team Lead) agent runs from the main repo root (`C:\Git\itsg-kea`),
the team name will be `itsg-kea`. The dashboard treats this as the orchestrator
session — it spawns and monitors teams but is not itself a "worker" team.

### 3.4 Environment variable override

If `CLAUDE_WORKTREE_NAME` is set, it takes precedence:

```sh
TEAM_NAME="${CLAUDE_WORKTREE_NAME:-$TEAM_NAME}"
```

This allows explicit team naming when the path-based detection is insufficient
(e.g., non-standard worktree locations).

---

## 4. settings.json Configuration

### 4.1 Existing hooks that MUST coexist

Some target projects may already have hooks configured:
- `TeammateIdle` → `.claude/hooks/pr-watcher-idle.sh` (per-worktree CI monitoring)
- `pre-tool-use` → `.claude/hooks/bash-worktree-fix.sh` (documented but not in settings.json — applied via Claude Code's built-in worktree support)

Fleet Commander adds its own observer hook to TeammateIdle (and all other
event types). FC hooks are fire-and-forget (exit 0, empty stdout) and do
not affect agent behavior, so they coexist safely with domain-specific
hooks like pr-watcher-idle.sh via the array syntax.

### 4.2 Complete settings.json for a worktree

See `settings.json.example` in this directory. Key points:

- **TeammateIdle has both domain-specific and FC observer hooks.** The
  existing pr-watcher-idle.sh hook may return JSON to control agent
  behavior. Fleet Commander's `on_teammate_idle.sh` runs alongside it
  as a pure observer — it exits 0 with empty stdout, so it never
  interferes with the domain hook's return value. Multiple hooks per
  event type are supported via the array syntax; each entry runs
  independently.

- **Multiple hooks per event type** are supported via the array syntax.
  Each entry in the array is independent. If one hook fails, the others
  still run.

- **All Fleet Commander hooks use `type: "command"`** (shell commands).
  HTTP hooks would be simpler but less portable — the shell wrappers
  provide logging, team identification, and graceful failure handling
  that a raw HTTP hook cannot.

### 4.3 Deployment to worktrees

When creating a new worktree for a team, copy the settings.json:

```bash
# In the coordinator script that creates worktrees:
WORKTREE=".claude/worktrees/kea-${ISSUE_NUM}"
mkdir -p "${WORKTREE}/.claude"
cp .claude/hooks/fleet-commander/settings.json.example "${WORKTREE}/.claude/settings.json"
```

Or patch the existing settings.json to add Fleet Commander hooks.

### 4.4 PostToolUse rate limiting

PostToolUse fires on EVERY tool call. For an active agent, this could be
multiple times per second. The dashboard should deduplicate/throttle, but
as an additional safeguard, the `on_post_tool_use.sh` wrapper can be
modified to throttle:

```sh
# Optional: skip if last event was <5 seconds ago
THROTTLE_FILE="/tmp/fc-${TEAM_NAME:-unknown}-throttle"
if [ -f "$THROTTLE_FILE" ]; then
    last=$(cat "$THROTTLE_FILE" 2>/dev/null || echo 0)
    now=$(date +%s 2>/dev/null || echo 0)
    diff=$((now - last))
    if [ "$diff" -lt 5 ]; then
        exit 0
    fi
fi
date +%s > "$THROTTLE_FILE" 2>/dev/null
```

This reduces network traffic from ~60 events/minute to ~12 without losing
the "team is alive" signal.

---

## 5. "Last Activity" Tracking for Stuck Detection

### 5.1 Dashboard-side logic

The dashboard maintains a per-team state object:

```python
teams = {
    "kea-777": {
        "status": "active",          # active | idle | stuck | completed
        "last_seen": "2026-03-16T14:30:45Z",
        "session_id": "sess_abc123",
        "agents": ["coordinator", "csharp-dev", "weryfikator"],
        "last_tool": "Edit",
        "error_count_5min": 0,
        "compact_count": 0,
        "stop_count_5min": 0,
    }
}
```

### 5.2 State transitions

```
                    tool_use event
    +---------+    (any tool)     +--------+
    |  idle   | ----------------→| active |
    +---------+                   +--------+
         ^                            |
         |   no events for 2 min      |
         +----------------------------+
                                      |
         +----------------------------+
         |   no events for 5 min
         v
    +---------+
    |  stuck  |  ← ALERT: human attention needed
    +---------+
         |
         |   session_end event
         v
    +----------+
    | completed|
    +----------+
```

### 5.3 Thresholds

| Condition                         | Threshold | Status   |
|-----------------------------------|-----------|----------|
| Last tool_use < 2 min ago         | -         | active   |
| Last tool_use 2-5 min ago         | 2 min     | idle     |
| Last tool_use > 5 min ago         | 5 min     | stuck    |
| error_count in last 5 min > 10    | 10        | flailing |
| compact_count > 3 in session      | 3         | complex  |
| stop_count in last 5 min > 5      | 5         | thrashing|

### 5.4 Which events update last_seen

- `tool_use` — YES (primary heartbeat)
- `tool_error` — YES (errors still mean the agent is alive)
- `subagent_start` / `subagent_stop` — YES (lifecycle activity)
- `notification` — NO (notifications can fire while agent is idle)
- `pre_compact` — YES (context management is activity)
- `stop` — YES (but also triggers idle timer)
- `session_start` — YES (initial timestamp)
- `session_end` — marks team as completed, no more tracking

---

## 6. Edge Cases

### 6.1 Dashboard server not running

**Behavior:** `curl` fails silently. The `send_event.sh` script backgrounds
the curl call and always exits 0. Claude Code sees no error. Events during
downtime are lost.

**Mitigation:** The dashboard should persist state to disk. When it restarts,
it can reconstruct team status from:
- Active worktrees (`git worktree list`)
- Recent git log per worktree
- GitHub PR status

### 6.2 Multiple hooks per event

Claude Code supports arrays of hooks per event type. The Fleet Commander
hooks run independently from existing hooks like `pr-watcher-idle.sh`.

For TeammateIdle, both the domain-specific hook and the FC observer hook
coexist in the array. FC's `on_teammate_idle.sh` exits 0 with empty
stdout, so it never interferes with the domain hook's return value:

```json
"TeammateIdle": [
  {
    "hooks": [
      { "type": "command", "command": ".claude/hooks/pr-watcher-idle.sh" }
    ]
  },
  {
    "hooks": [
      { "type": "command", "command": "bash .claude/hooks/fleet-commander/on_teammate_idle.sh" }
    ]
  }
]
```

Each entry in the array runs independently. FC hooks are pure observers
that never return control directives — they fire and forget.

### 6.3 Hook timeout / blocking

**Guarantee:** `send_event.sh` uses:
- `curl --max-time 2 --connect-timeout 1`
- Backgrounded with `&`
- Always exits 0

Even in worst case (DNS resolution hang), the hook returns in under 2
seconds. Claude Code's hook timeout (if any) is not hit.

### 6.4 Worktree not yet created

If a hook fires before `git rev-parse` can identify the worktree (e.g.,
during setup), the fallback is `pwd`. The team name will be a path
component, which the dashboard can still track.

### 6.5 Concurrent writes from multiple agents

Multiple agents within the same worktree fire hooks simultaneously. Since
each hook invocation is a separate process with its own curl call, there
are no concurrency issues. The dashboard handles concurrent POSTs via
standard HTTP server mechanisms.

### 6.6 Windows-specific path handling

The project runs on Windows 10 with Git Bash. Paths use forward slashes
in the bash hooks (`/c/Git/itsg-kea/...`). The `git rev-parse` command
returns Unix-style paths in Git Bash, so the sed-based extraction works
correctly.

### 6.7 High event volume

A team with 4 active agents, each making ~1 tool call per second, produces
~240 events/minute. With the optional 5-second throttle on PostToolUse,
this drops to ~48 events/minute. The dashboard should batch-insert and
dedup by `(team, event, timestamp_rounded_to_second)`.

---

## 7. File Inventory

```
.claude/hooks/fleet-commander/
  DESIGN.md                  ← this document
  send_event.sh              ← core: builds payload and POSTs to dashboard
  on_session_start.sh        ← hook: SessionStart
  on_session_end.sh          ← hook: SessionEnd
  on_stop.sh                 ← hook: Stop
  on_stop_failure.sh         ← hook: StopFailure
  on_subagent_start.sh       ← hook: SubagentStart
  on_subagent_stop.sh        ← hook: SubagentStop
  on_teammate_idle.sh        ← hook: TeammateIdle
  on_notification.sh         ← hook: Notification
  on_pre_compact.sh          ← hook: PreCompact
  on_post_tool_use.sh        ← hook: PostToolUse (heartbeat)
  on_tool_error.sh           ← hook: PostToolUseFailure
  settings.json.example      ← complete settings.json with all hooks wired
```

---

## 8. Dashboard Server API Contract

The dashboard server must expose:

```
POST /api/events
Content-Type: application/json

{
  "event": "tool_use",
  "team": "kea-777",
  "timestamp": "2026-03-16T14:30:45Z",
  ...
}

Response: 200 OK (body ignored by hooks)
Response: Any error (ignored by hooks)
```

The dashboard also polls GitHub independently for PR/CI status using
`gh pr view` and `gh run list` — this data is merged with hook events
to build the complete team status view.

---

## 9. Quick Start

1. Copy the hook scripts to each worktree's `.claude/hooks/fleet-commander/`
2. Copy `settings.json.example` to each worktree's `.claude/settings.json`
   (merge with existing hooks if needed)
3. Start the Fleet Commander dashboard on port 4680
4. Launch Claude Code teams — events flow automatically
5. Open the dashboard UI to see fleet status

To disable without removing hooks:
```bash
export FLEET_COMMANDER_OFF=1
```

# Diamond Team Architecture

**Date:** 2026-03-18
**Status:** Design proposal
**Replaces:** 4-agent hub-and-spoke model (coordinator + analyst + dev + reviewer)

---

## Motivation

Data from 21 teams (2671 events, 1499 tool calls) shows structural problems with the current 4-agent model:

| Problem | Evidence |
|---------|----------|
| Coordinator is a bottleneck | 34% of all inter-agent messages flow through it |
| Coordinator does almost no real work | 12.6% of tool calls, but consumes a full agent slot |
| Coordinator has highest error rate | 27.7% Bash error rate (4x worse than dev) |
| Hub-and-spoke adds latency | Every handoff requires two message hops (agent -> coordinator -> agent) |
| Research shows 2-3 agents optimal | Larger teams hit diminishing returns; p2p slightly outperforms hub-and-spoke |

The coordinator's only essential functions are: routing briefs from analyst to dev, routing review feedback between dev and reviewer, creating PRs, and managing the state machine. All of these can be done by the TL (CC main process) or by the agents themselves.

---

## Architecture Overview

```
                    Fleet Commander (stdin messages)
                           |
                           v
                    +------+------+
                    |     TL      |  (CC main process)
                    | orchestrator|
                    +------+------+
                   / spawn  |  spawn \  (all 3 spawned immediately)
                  /         |         \
           +-----+    +----+----+    +--------+
           |Analyst|   |   Dev   |   |Reviewer|
           +---+---+   +----+---+   +----+---+
               |  brief     ^   \        ^  |
               +----------->|    \       |  |
               +--- CC -----|---->\      |  |
               +---> TL     |     +------+  |
                            |     p2p loop  |
                            |      (direct) |
                            |               |
                                  final approval --> TL
```

**Shape:** The flow forms a diamond: TL at top, analyst and reviewer on the sides, dev at the bottom where work converges. Hence "Diamond."

**Parallel spawn:** All 3 agents are spawned immediately at startup. Dev enters warm-up (read-only) and reviewer enters pre-read (read-only) while analyst works. Analyst sends brief directly to dev and CCs reviewer via SendMessage.

### The Three Agents

| Agent | Role | Tools | Lifecycle |
|-------|------|-------|-----------|
| **analyst** | Investigate codebase, produce structured brief with guidebook recommendations. Sends brief directly to dev + reviewer + TL. | Read-only: Glob, Grep, Read, Bash (read-only), LS | Spawned immediately at startup. Exits after delivering brief. |
| **dev** | Warm-up phase (read-only) until brief arrives, then implements changes, writes tests, fixes review feedback, creates commits | Full: Glob, Grep, Read, Edit, Write, Bash, Agent | Spawned immediately at startup. Warm-up phase until brief arrives. Long-lived. |
| **reviewer** | Pre-read phase (read-only) until review request arrives, then two-pass code review (quality + acceptance), direct feedback to dev | Read-only: Glob, Grep, Read, Bash (read-only), LS | Spawned immediately at startup. Pre-read phase until dev sends review request. May persist for multiple rounds. |

### TL Role (CC Main Process)

The TL absorbs all orchestration that the coordinator used to do:

| Responsibility | How |
|----------------|-----|
| Spawn analyst with issue context | `Agent` tool with issue number and project context |
| Receive brief from analyst | Analyst returns brief as its final output (Agent tool result) |
| Spawn dev with brief + guidebook list | `Agent` tool with brief in prompt |
| Detect "ready for review" signal from dev | Dev writes a signal file OR TL polls for it |
| Spawn reviewer with file list | `Agent` tool with changed files |
| Route reviewer feedback to dev (first round) | TL receives reviewer output, sends to dev via `SendMessage` |
| Enable p2p for subsequent rounds | Dev and reviewer communicate directly after first round |
| Enforce review round limit | TL counts rounds, intervenes at max |
| Create PR after final approval | TL runs `gh pr create` + `gh pr merge --auto` directly |
| Handle FC stdin messages (CI, stuck, etc.) | TL is already the stdin recipient |

**Key insight:** The TL already exists as the CC main process. It has full tool access. The coordinator was a subagent doing what the TL should have been doing all along.

---

## Communication Flows

### Flow 0: TL -> All 3 Agents (parallel spawn at startup)

```
TL spawns ALL 3 agents simultaneously via Agent tool:

  Analyst:
    "Analyze issue #N in {project}. Read CLAUDE.md first.
     Produce a structured brief.
     Send the brief directly to 'dev' AND 'reviewer' via SendMessage (CC both).
     Also send to TL for validation."

  Dev:
    "Issue #N. Branch: {branch}. Base: {base}.
     WARM-UP: Read CLAUDE.md, guidebooks, explore codebase.
     Wait for analyst brief via SendMessage from 'analyst'.
     After brief arrives: implement, test, commit, push.
     Send review request to 'reviewer' via SendMessage when ready."

  Reviewer:
    "Issue #N. Base: {base}.
     PRE-READ: Read CLAUDE.md, guidebooks, familiarize with codebase.
     Wait for review request via SendMessage from 'dev'.
     After request arrives: two-pass review, send feedback to dev directly."
```

All three are **long-lived subagents** spawned in parallel. TL monitors all three.

### Flow 1: Analyst -> Dev + Reviewer + TL (brief delivery via SendMessage)

The analyst sends the brief to **three recipients** via `SendMessage`:
1. `dev` — triggers dev's transition from warm-up to implementation
2. `reviewer` — gives reviewer early context on what to expect
3. TL — for validation and workflow state tracking

```
Brief format:
  ISSUE: #N {title}
  TYPE: {language/framework}
  FILES:
    - {path} -- {what changes and why}
  SCOPE: {concise implementation description}
  RISKS: {specific risks}
  BLOCKED: no | yes -> {reason}
  GUIDEBOOKS:
    - .claude/agents/fleet-dev-typescript.md -- TypeScript conventions
    - docs/api-patterns.md -- REST API patterns used in this project
```

### Flow 2: Dev warm-up -> implementation (triggered by brief)

Dev receives the analyst's brief via `SendMessage`. This triggers the transition:
- Parse the brief for additional guidebook paths — read any not yet read during warm-up
- Create branch, implement, test, commit, push
- Send review request to `reviewer` via `SendMessage`

### Flow 3: Dev -> Reviewer + TL (ready for review signal)

Dev signals "ready for review" by sending to **two recipients**:

1. **Reviewer** (via `SendMessage`) — triggers reviewer's transition from pre-read to active review. Includes branch name, changed files, and focus areas.
2. **TL** (via `SendMessage`) — for workflow state tracking: `"Ready for review. Branch: feat/N-desc."`

The reviewer is already spawned and in pre-read phase. No spawning needed — the `SendMessage` is the trigger.

### Flow 4: Dev <-> Reviewer (DIRECT p2p)

This is the core innovation. After the first review round, dev and reviewer talk directly.

```
Reviewer -> Dev (via SendMessage):
  "REJECT -- 3 issues found:
   1. src/server/routes/teams.ts:45 -- missing input validation
   2. src/server/services/poller.ts:112 -- swallowed error
   3. Missing test for 404 error path"

Dev -> Reviewer (via SendMessage):
  "Fixed all 3 issues. Pushed to feat/42-fix-validation.
   Please re-review files: teams.ts, poller.ts, poller.test.ts"

Reviewer -> Dev (via SendMessage):
  "APPROVE -- all issues resolved, acceptance criteria met."
```

### Flow 5: Dev -> TL (work complete)

After reviewer approves, dev sends final status to TL:
```
"Review approved. Branch feat/N-desc pushed and ready for PR.
 Reviewer verdict: APPROVE"
```

### Flow 6: Reviewer -> TL (final approval)

Reviewer sends approval to TL as well (belt and suspenders):
```
"VERDICT: APPROVE -- code quality OK, acceptance criteria met."
```

TL receives approval from both dev and reviewer, then creates the PR.

---

## How P2P Works (Answering the Design Questions)

### Q1: How does dev know to talk to reviewer directly instead of through TL?

**The dev's spawn prompt explicitly instructs this.** The dev is spawned with instructions to send the review request directly to `reviewer` via SendMessage. Since all agents are spawned at the same time, the dev knows the reviewer's name (`reviewer`) from the spawn prompt — no separate introduction needed.

The dev's prompt includes:
> "Send review request to 'reviewer' via SendMessage when ready. The reviewer may send you feedback directly via SendMessage. Address feedback, commit, push, and reply to the reviewer directly."

### Q2: How does reviewer know to send feedback to dev instead of TL?

**The reviewer's spawn prompt explicitly instructs this.** The reviewer is spawned with:

```
"PRE-READ: Read CLAUDE.md, guidebooks, familiarize with codebase.
 Wait for review request via SendMessage from 'dev'.

 FEEDBACK PROTOCOL:
 - Send your verdict directly to 'dev' via SendMessage.
 - If REJECT: include specific file:line issues. Dev will fix and notify you.
 - If APPROVE: send approval to both 'dev' and TL.
 - You may do up to 3 review rounds total."
```

Since all agents are spawned simultaneously, the reviewer knows the dev's name (`dev`) from the spawn prompt.

### Q3: What happens if dev and reviewer get into infinite loop?

**Hard limit of 3 review rounds, enforced at three levels:**

1. **Reviewer's prompt** says "max 3 review rounds total (initial + 2 re-reviews)." After the 3rd rejection, reviewer sends `BLOCKED` to TL instead of another rejection to dev.

2. **Dev's prompt** says "After 2 feedback rounds with no resolution, escalate to TL." Dev stops responding to reviewer and messages TL.

3. **TL counts rounds** by monitoring SendMessage events between dev and reviewer (visible via hook events). If TL sees 3 reject/fix cycles, TL intervenes regardless of what the agents do.

```
Round 1: Reviewer REJECT -> Dev fixes -> Dev notifies Reviewer
Round 2: Reviewer REJECT -> Dev fixes -> Dev notifies Reviewer
Round 3: Reviewer REJECT -> Reviewer sends BLOCKED to TL
                          -> Dev escalates to TL
         TL: "3 rejections reached. Moving to BLOCKED state."
```

### Q4: When does TL intervene vs let p2p happen?

| Situation | TL Action |
|-----------|-----------|
| Normal review round (1-2) | Let p2p happen. Do not intervene. |
| 3rd rejection | Intervene. Transition to BLOCKED. |
| Dev or reviewer idle > 5 min during p2p | Send nudge to the idle agent. |
| Dev reports escalation | Take over. Assess if issue is BLOCKED or needs different approach. |
| Reviewer sends conflicting signals | Ask reviewer to clarify. |
| FC sends `ci_red` | Forward to dev (TL is stdin recipient, dev cannot receive FC messages directly). |
| FC sends `ci_blocked` | Intervene. Stop all agents. Transition to BLOCKED. |

**Rule of thumb:** TL is hands-off during p2p rounds 1-2. TL is hands-on for round 3+, FC messages, and idle/stuck detection.

### Q5: How many review rounds before TL steps in?

**3 total rounds** (matching the current system):

| Round | What happens |
|-------|-------------|
| 1 (initial review) | Reviewer reviews, sends verdict to dev. APPROVE -> done. REJECT -> round 2. |
| 2 (first re-review) | Dev fixes, reviewer re-reviews ONLY previously flagged issues + new issues from fixes. |
| 3 (final re-review) | Same as round 2. If still REJECT -> BLOCKED. |

After round 3 REJECT:
- Reviewer sends `BLOCKED` to TL with summary of unresolved issues
- Dev sends escalation to TL
- TL transitions team to BLOCKED state
- TL comments on the GitHub issue explaining the blocker

---

## Phase Mapping

The existing `TeamPhase` type maps to Diamond stages:

| Phase | Diamond Stage | Active Agents |
|-------|--------------|---------------|
| `init` | TL spawns all 3 agents in parallel | TL + analyst + dev (warm-up) + reviewer (pre-read) |
| `analyzing` | Analyst investigating; dev in warm-up; reviewer in pre-read | TL + analyst + dev (warm-up) + reviewer (pre-read) |
| `implementing` | Dev building; reviewer in pre-read | TL + dev + reviewer (pre-read) |
| `reviewing` | Dev + reviewer in p2p loop | TL + dev + reviewer |
| `pr` | TL creating PR, waiting for CI | TL (+ dev if CI fix needed) |
| `done` | Complete | TL closing out |
| `blocked` | Cannot proceed | TL reporting |

---

## Sequence Diagram

```
TL                    Analyst              Dev                  Reviewer
|                       |                   |                      |
|== spawn all 3 agents simultaneously ============================>|
|-- spawn (issue ctx) ->|                   |                      |
|-- spawn (warm-up) ----|------------------>|                      |
|-- spawn (pre-read) ---|-------------------|--------------------->|
|                       |                   |                      |
|                       |-- read CLAUDE.md  |-- read CLAUDE.md     |-- read CLAUDE.md
|                       |-- explore code    |-- read guidebooks    |-- read guidebooks
|                       |-- trace deps      |-- explore codebase   |-- explore codebase
|                       |-- produce brief   |   (warm-up phase)    |   (pre-read phase)
|                       |                   |                      |
|                       |-- brief to dev -->|                      |
|                       |-- brief CC -------|--------------------->|
|<-- brief to TL -------|                   |                      |
|       (validate)      X (exits)           |                      |
|                                           |                      |
|                                           |-- create branch      |
|                                           |-- implement          |
|                                           |-- test locally       |
|                                           |-- commit + push      |
|                                           |                      |
|                                           |-- review request --->|
|<-------- "ready for review" ------------- |                      |
|                                           |                      |
|                                           |<-- REJECT (issues) --|
|                                           |-- fix + push         |
|                                           |-- "fixed, re-review" |
|                                           |              ------->|
|                                           |                      |
|                                           |<--- APPROVE ---------|
|<-------- "approved, ready for PR" --------|                      |
|<------------------------------------------------ APPROVE --------|
|                                           |                      X (exits)
|-- gh pr create                            |
|-- gh pr merge --auto                      |
|                                           |
| (FC sends ci_green via stdin)             |
|                                           |
|-- gh issue close                          X (exits)
|-- done
```

---

## Edge Cases

### 1. Analyst finds blocker

```
Analyst brief: BLOCKED=yes -> {reason}
TL: Send shutdown_request to dev and reviewer (they were in warm-up/pre-read).
    Comment on issue. Transition to BLOCKED.
    Token cost: dev and reviewer consumed warm-up tokens (reading CLAUDE.md, guidebooks)
    but this is minimal compared to implementation/review tokens.
```

### 2. Dev crashes or exits unexpectedly

```
TL detects Agent tool failure (dev subagent exited non-zero).
TL: Transition to FAILED.
FC: Process exit handler updates team status.
PM: Can relaunch from dashboard.
```

### 3. Reviewer crashes during p2p

```
Dev sends message to reviewer, gets no response.
Dev waits 3 min, then escalates to TL: "Reviewer unresponsive."
TL: Respawn reviewer with same context.
     New reviewer starts fresh review (round counter preserved by TL).
```

### 4. CI fails after PR creation

```
FC sends ci_red to TL via stdin.
TL forwards failure details to dev (dev is still alive after PR phase).
Dev: Fix, commit, push. CI re-runs automatically.
TL: Wait for next FC ci_green or ci_red.
After 3 unique CI failure types: FC sends ci_blocked. TL transitions to BLOCKED.
```

### 5. Dev and reviewer disagree fundamentally

```
Round 3: Reviewer rejects for the same issue dev believes is correct.
Both escalate to TL.
TL: Read the disputed code. Make a judgment call.
    Either: tell dev exactly what to change (TL becomes tiebreaker)
    Or: transition to BLOCKED with explanation for PM.
```

### 6. Mixed-language task (analyst identifies multiple types)

```
Analyst brief: TYPE=mixed (TypeScript + SQL)
TL: Still spawns one generalist dev.
    Dev's prompt includes the full brief with both types.
    Generalist dev handles both (per CLAUDE.md: "adapt to whatever language").
    If truly specialized work needed: TL spawns a second dev sequentially
    (first dev does part A, second dev does part B, then reviewer reviews all).
```

### 7. Dev finishes before reviewer completes pre-read

Normal case. Dev sends review request to reviewer via SendMessage. The reviewer may still be completing pre-read (reading guidebooks, exploring codebase). The reviewer transitions to active review upon receiving the SendMessage. Dev is idle during review — this is expected. FC's idle detection should not penalize dev for waiting during review.

### 8. FC sends stuck_nudge during p2p

```
FC detects team idle > 5 min (e.g., reviewer is slow).
FC sends stuck_nudge to TL.
TL: Check which agent is idle.
    If reviewer: send nudge to reviewer.
    If dev (waiting for review): tell FC "dev waiting for reviewer, not stuck."
```

---

## What Changes in Fleet Commander

### Templates to modify

| File | Change |
|------|--------|
| `templates/workflow.md` | Replace 4-agent team structure with 3-agent Diamond. Remove coordinator references. TL becomes orchestrator. |
| `templates/agents/fleet-analyst.md` | Send brief to dev + reviewer + TL via SendMessage (3 recipients). Analyst knows all agent names from spawn. |
| `templates/agents/fleet-dev.md` | Add Warm-Up Phase (read-only until brief arrives). Send review request directly to reviewer. |
| `templates/agents/fleet-reviewer.md` | Add Pre-Read Phase (read-only until review request arrives). FEEDBACK PROTOCOL for direct p2p with dev. |
| `templates/agents/fleet-coordinator.md` | **DELETE** (or archive). No longer needed. |
| `prompts/default-prompt.md` | Update TL instructions: no coordinator spawn, TL owns orchestration. |

### Server code changes

| File | Change |
|------|--------|
| `src/shared/types.ts` | No change needed. TeamPhase values still valid. |
| `src/shared/state-machine.ts` | No change needed. Team lifecycle states are orthogonal to agent architecture. |
| `src/server/services/team-manager.ts` | No change needed. Team spawning is architecture-agnostic (one CC process per team). |
| `src/server/services/stuck-detector.ts` | Consider: exclude "dev waiting for review" from idle detection. |

### What does NOT change

- Fleet Commander server code (spawn, hooks, SSE, polling)
- Database schema (teams, events, PRs)
- State machine transitions
- Hook scripts
- Dashboard UI
- FC message templates (ci_green, ci_red, etc.)

The Diamond architecture is entirely a **prompt-level change**. Fleet Commander's server treats each team as a single CC process. The internal agent structure is defined by the workflow template and agent templates deployed to the target repo. No server code changes required.

---

## Comparison: Current vs Diamond

| Metric | Current (4-agent) | Diamond (3-agent) |
|--------|-------------------|-------------------|
| Agents per team | 4 (coordinator + analyst + dev + reviewer) | 3 (analyst + dev + reviewer) |
| Message hops for review feedback | 3 (reviewer -> coordinator -> dev) | 1 (reviewer -> dev) |
| Message hops for brief delivery | 3 (analyst -> coordinator -> dev) | 1 (analyst -> dev via SendMessage, direct) |
| Orchestration overhead | ~12.6% of tool calls wasted on coordinator | 0% (TL orchestrates natively) |
| Bash error rate from orchestration | 27.7% (coordinator) | Near 0% (TL does fewer, simpler commands) |
| Token consumption | 4 agent contexts | 3 agent contexts (25% reduction) |
| Latency per review round | ~2-4 min (two-hop routing) | ~1-2 min (direct p2p) |
| Complexity | High (coordinator prompt is 129 lines of state machine logic) | Lower (TL logic is simpler; agents own their protocols) |

### Expected improvements

- **25% fewer tokens** per team (one fewer agent context)
- **50% faster review rounds** (direct p2p vs two-hop routing)
- **~15% fewer errors** (removing coordinator's 27.7% Bash error rate)
- **Simpler debugging** (fewer message hops to trace in event log)
- **Faster overall cycle time** — dev and reviewer frontload context-gathering during analyst phase (parallel warm-up/pre-read eliminates sequential wait)

---

## Migration Plan

### Phase 1: Template changes (no server changes)

1. Update `fleet-analyst.md` — brief sent directly to dev + reviewer + TL via SendMessage
2. Update `fleet-dev.md` — add Warm-Up Phase (read-only until brief arrives via SendMessage)
3. Update `fleet-reviewer.md` — add Pre-Read Phase (read-only until review request arrives via SendMessage)
4. Update `workflow.md` — parallel spawn of all 3 agents at Phase 0, decoupled from phase transitions
5. Update `default-prompt.md` — TL spawns all 3 agents immediately
6. Archive `fleet-coordinator.md` (move to `templates/archive/`)

### Phase 2: Test on one project

1. Install Diamond templates on a test project
2. Run 5-10 issues through the pipeline
3. Compare metrics: time to PR, error rate, token usage, review round count

### Phase 3: Roll out

1. Update install.sh to deploy Diamond templates
2. Re-install on all registered projects
3. Monitor first batch of teams on dashboard

### Phase 4: Clean up

1. Remove coordinator references from documentation
2. Update CLAUDE.md team structure description
3. Archive analysis data from 4-agent era for comparison

---

*Diamond architecture designed from analysis of 21 teams, 2671 events. The single biggest win is eliminating the coordinator bottleneck and letting agents talk directly.*

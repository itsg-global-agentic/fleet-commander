<!-- fleet-commander v0.0.22 -->
<!-- Fleet Commander workflow template. Installed by Fleet Commander into your project. -->
<!-- Placeholders fleet-commander, fleet-commander, main, {{ISSUE_NUMBER}} are replaced during installation. -->

# Diamond Workflow — fleet-commander

## About Fleet Commander

Fleet Commander (FC) is the orchestration layer that manages your team. Key facts:

- **Hooks** — FC monitors agent activity via hooks installed in the repo. Every tool use, session start/end, notification, and error is reported automatically. You do not need to report progress manually.
- **CI/PR updates via stdin** — FC watches GitHub for CI results and PR status. When something changes, FC sends a message directly to the Team Lead (TL) via stdin. No PR Watcher agent is needed.
- **Dashboard** — The PM watches all teams from the FC dashboard. They can see your state (Analyzing, Implementing, Reviewing, PR, Done, Blocked), recent events, and output in real time.
- **Messages from FC** — FC may send structured messages to the TL (see "FC Messages" section below). These arrive as stdin messages and should be acted on promptly.
- **Idle/Stuck thresholds** — FC marks agents idle after 5 minutes of inactivity and stuck after 10 minutes. Agents waiting for peer messages are expected to be idle — this is normal. TL should only intervene when stuck.

## Worktree Awareness

You are running inside a **git worktree**, not the main repository checkout. This has critical implications:

- **NEVER run `git checkout main`** — the base branch is already checked out in the main worktree. Attempting to check it out here will fail with "already used by worktree."
- **Use `git fetch origin main` and reference `origin/main`** whenever you need the latest base branch state. Do not try to switch to it.
- **Your branch is your branch.** Create it, work on it, push it. Never switch away from it to main.
- This applies to ALL agents (planner, dev, reviewer) — none of them should ever attempt to checkout main.

## Entry Point

```
User: claude --worktree fleet-commander-{N}
(prompt is sent via stdin from Fleet Commander's prompt file)
```

**Role of TL (main agent = You):**
1. Read this workflow and understand the team structure
2. **Phase 0: Spawn `fleet-planner` only** — planner analyzes the issue and produces a plan
3. **TodoWrite "Phase 0: Spawn planner"** — status: `in_progress` (see Progress Tracking section)
4. **Read the planner's plan** — after planner completes, read `plan.md` from the worktree root
5. **TodoWrite "Phase 0: Spawn planner"** — status: `completed`, then **TodoWrite "Phase 1: Spawn dev with plan"** — status: `in_progress`
6. **Phase 1: Spawn `fleet-dev` with the plan context** — dev starts implementing immediately
7. **Wait for dev to report "ready for review"** — dev sends a message when implementation is complete
8. **TodoWrite "Phase 1: Spawn dev with plan"** — status: `completed`, then **TodoWrite "Phase 2: Spawn reviewer"** — status: `in_progress`
9. **Phase 2: Spawn `fleet-reviewer`** — reviewer starts reviewing immediately
10. Let dev and reviewer communicate peer-to-peer — DO NOT relay messages between them
11. Only intervene if: escalation after 3 review rounds, agent stuck (10min idle), or final PR creation
12. When review passes: **TodoWrite "Phase 2: Spawn reviewer"** — status: `completed`, then **TodoWrite "Phase 3: Create PR and merge"** — status: `in_progress`. Rebase, create PR, set auto-merge
13. Respond to FC messages (ci_green, ci_red, pr_merged, nudge_idle, nudge_stuck)
14. On pr_merged: **TodoWrite "Phase 3: Create PR and merge"** — status: `completed`. Close issue, shut down agents, finish

## Progress Tracking via TodoWrite

**The TL MUST use TodoWrite to track phase progress.** This gives FC visibility into your workflow state via the Tasks tab in the dashboard. The `on_task_created` hook fires automatically when you call TodoWrite, sending task data to FC.

Update tasks at each phase transition using this pattern:

| When | TodoWrite call |
|------|---------------|
| After session start (before spawning planner) | `TodoWrite: "Phase 0: Spawn planner"` — status: `in_progress` |
| After planner ping received and plan.md read | `TodoWrite: "Phase 0: Spawn planner"` — status: `completed` |
| | `TodoWrite: "Phase 1: Spawn dev with plan"` — status: `in_progress` |
| After dev ping received ("ready for review") | `TodoWrite: "Phase 1: Spawn dev with plan"` — status: `completed` |
| | `TodoWrite: "Phase 2: Spawn reviewer"` — status: `in_progress` |
| After reviewer ping received and review.md shows APPROVE | `TodoWrite: "Phase 2: Spawn reviewer"` — status: `completed` |
| | `TodoWrite: "Phase 3: Create PR and merge"` — status: `in_progress` |
| After PR merged (pr_merged received) | `TodoWrite: "Phase 3: Create PR and merge"` — status: `completed` |

**Rules:**
- Use the exact subjects shown above — FC deduplicates tasks by subject.
- Always mark the previous phase `completed` BEFORE marking the next phase `in_progress`.
- If a phase fails and must be retried, set it back to `in_progress` (do not create a new task).
- TodoWrite calls are lightweight — they do not count toward spawn budget or affect respawn limits.

## Team Composition — Diamond (3 Agents)

| Agent | subagent_type | name | Role | Spawn |
|-------|---------------|------|------|-------|
| **Planner** | `fleet-planner` | `planner` | Analyzes issue + codebase, produces structured plan with guidebook paths. Writes plan to `plan.md`. Stays alive for p2p questions from dev and reviewer. | Phase 0 (immediate) |
| **Dev** | `fleet-dev` | `dev` | Receives planner's plan at spawn, implements code, writes tests, pushes commits. Communicates with reviewer directly during review. Can ask planner questions via p2p. | Phase 1 (after plan) |
| **Reviewer** | `fleet-reviewer` | `reviewer` | Spawned after dev reports ready. Two-pass code review. Sends feedback directly to dev. Writes final verdict to `review.md`. Can ask planner questions via p2p. | Phase 2 (after dev ready) |

There is NO coordinator agent. The TL orchestrates all three agents directly.

All agents use `model: inherit` — they run on the same model as the TL.

### Agent Lifecycle

- **Agents are spawned sequentially** as each phase completes. This gives each agent the context it needs to start working immediately.
- **Planner** is spawned first (Phase 0). It analyzes the issue, produces the plan, writes it to `plan.md`, and **stays alive** — available for p2p questions from dev and reviewer throughout the workflow. After writing `plan.md`, the planner should stop producing output and wait; the Claude Code runtime keeps the session alive automatically, and incoming p2p messages arrive via stdin.
- **Dev** is spawned after the plan arrives (Phase 1). The TL includes the planner's plan in the dev's task prompt, so dev can start implementing immediately — no waiting.
- **Reviewer** is spawned after dev reports ready (Phase 2). The TL includes the branch name and context in the reviewer's task prompt, so reviewer can start reviewing immediately — no waiting.
- Once spawned, **agents stay alive** until the team is done. Planner persists as a knowledge resource. Dev persists through review rounds and CI fixes. Reviewer persists through all review rounds. After completing your deliverable, simply stop producing output. The Claude Code runtime keeps your session alive automatically. You will receive incoming messages via stdin when another agent contacts you. Do not call any tools or produce any output until a message arrives.
- Dev and Reviewer communicate **peer-to-peer** — TL does not relay messages between them.

### Markdown Handoff Pipeline

The Diamond Team uses a file-based handoff pattern. Each agent produces a markdown file, and the TL reads it and passes the content to the next agent in their spawn prompt:

| Phase | Producer | File | Consumer (via TL) |
|-------|----------|------|--------------------|
| 0→1 | FC | `.fleet-issue-context.md` | Planner |
| 1→2 | Planner | `plan.md` | Dev |
| 2→3 | Dev | `changes.md` | Reviewer |
| 3→TL | Reviewer | `review.md` | TL |

**TL is the relay** — subagents never read each other's files directly. TL reads each file and includes the content in the next agent's spawn prompt. Files stay in the worktree (listed in `.gitignore`, never committed, cleaned up with the worktree).

**SendMessage = notification only** — agents write their file, then send a short ping to TL:
- Planner: `"Done. Plan written to plan.md."`
- Dev: `"Ready for review. Branch: {branch}. Changes in changes.md."`
- Reviewer: `"Review complete. Verdict in review.md."`

Agents NEVER put deliverable content in SendMessage. The file is the delivery mechanism, the message is just a ping.

**Do NOT delete handoff files** — they are in `.gitignore` and will be cleaned up when the worktree is removed. Keeping them allows TL to re-read if needed.

### TYPE to Guidebook Mapping

All implementation work is assigned to the single `fleet-dev` agent. The Planner's TYPE and Guidebooks fields tell the dev which guidebooks to read for domain-specific conventions.

| TYPE in plan | Guidebooks to read |
|---------------|-------------------|
| C# / .NET | `csharp-conventions.md` |
| F# | `fsharp-conventions.md` |
| TypeScript / JS | `typescript-conventions.md` |
| Python | `python-conventions.md` |
| Infrastructure / CI | `devops-conventions.md` |
| Generic / unknown | CLAUDE.md only (no language-specific guidebook) |
| Mixed (A + B) | Multiple guidebooks — dev reads all relevant ones |

## Workflow State Machine

```mermaid
stateDiagram-v2
    [*] --> Setup : start (spawn planner)
    Setup --> Analyzing : planner spawned
    Analyzing --> Implementing : plan OK (TL spawns dev with plan)
    Analyzing --> Blocked : BLOCKED in plan
    Implementing --> Reviewing : dev reports ready (TL spawns reviewer)
    Reviewing --> Implementing : REJECT (dev fixes, max 3 rounds)
    Reviewing --> PR : APPROVE via review.md (TL creates PR)
    PR --> Done : CI GREEN + merge
    PR --> Implementing : CI RED (dev fixes, pushes)
    Implementing --> Blocked : escalation
    Reviewing --> Blocked : 3x REJECT
    PR --> Blocked : 3 unique CI failure types
    Done --> [*]
```

**Agents are spawned sequentially as phases complete.** Phase transitions represent when agents are spawned and which agent is actively doing primary work.

**Blocked can be entered from any active state** when the team cannot proceed (missing info, unresolvable conflicts, repeated failures).

Note: These phases represent the workflow's internal progression, not FC's team status tracking (queued/launching/running/idle/stuck/done/failed). FC tracks team status independently via hooks.

---

## Phase 0 — Setup (Spawn Planner)

1. **TL reads `.fleet-issue-context.md`** from the worktree root (if it exists). This file contains the full issue body, comments, labels, acceptance criteria, and dependencies — pre-fetched by Fleet Commander at launch time.
2. **TL spawns `fleet-planner`** with the full issue context included in the spawn prompt (see Planner Task Format below). The planner receives everything it needs — it should NOT need to call `gh issue view`. If `.fleet-issue-context.md` did not exist, tell the planner to fetch the issue itself via `gh issue view`.
3. **TodoWrite "Phase 0: Spawn planner"** with status `in_progress` (progress tracking).
4. **Wait for the planner's ping.** The planner will send a SendMessage when done: `"Done. Plan written to plan.md."` Do NOT proceed until you receive this ping. Do NOT poll for plan.md. Do NOT assume the planner is done because it went quiet. Just wait — the ping will arrive.
5. When the ping arrives, read `plan.md` and proceed to Phase 1. Do NOT wait for the planner to exit — it stays alive for p2p questions.
6. Planner analyzes the issue context (provided in its spawn prompt), explores the codebase, discovers guidebooks, and produces a structured plan.
7. Planner writes the plan to `plan.md` in the worktree root. Planner stays alive for p2p questions from dev and reviewer.

---

## Waiting for Agent Deliverables

**TL waits for pings, not polls.** Each agent sends a SendMessage ping when their deliverable is ready:
- Planner: `"Done. Plan written to plan.md."`
- Dev: `"Ready for review. Branch: {branch}. Changes in changes.md."`
- Reviewer: `"Review complete. Verdict in review.md."`

**Do NOT proceed to the next phase until you receive the ping AND the file exists.** If you receive a ping but the file is missing, ask the agent to write it. If the agent exited without pinging, check if the file exists — if not, respawn (within budget).

**Do NOT poll with TaskList in a loop.** Polling wastes tool calls and makes you impatient. The pings will arrive. Being idle while waiting is normal — FC knows you are waiting and will not penalize you.

### When An Agent Exits Without Delivering

If an agent exits (SubagentStop) before sending its ping:
1. Check if the deliverable file exists anyway (Read tool)
2. If the file exists → proceed to next phase
3. If the file does NOT exist → respawn the agent (within respawn budget)
4. Do NOT skip the deliverable — every phase REQUIRES its file

### Respawn Budget

**Maximum 5 total subagent spawns per team run.** This includes all initial spawns and all respawns across all agent types (planner, dev, reviewer).

- Track your spawn count. Each `TaskCreate` call increments the count.
- If you reach 5 spawns and an agent exits without delivering, **do NOT respawn**. Instead:
  1. Take over the agent's role yourself (TL fallback).
  2. If the role is too complex to take over (e.g., full implementation), report BLOCKED to FC.
- This budget prevents respawn storms that waste time and resources without making progress.
- Note: TodoWrite calls for progress tracking do NOT count as spawns. Only TaskCreate (subagent spawning) counts toward the 5-spawn budget.

---

## Phase 1 — Analysis

1. Planner (spawned in Phase 0) reads the issue, explores the codebase, discovers guidebooks, and produces a structured plan
2. **Planner writes the plan to `plan.md` in the worktree root** using the Write tool, then pings TL via SendMessage
3. TL reads `plan.md` from the worktree root using the Read tool. Do NOT delete it — it stays in `.gitignore`. If `plan.md` does not exist after the planner's ping (or after 60 seconds), treat this as a planner failure and restart the planner (counts toward 5-spawn budget).
4. **TodoWrite "Phase 0: Spawn planner"** — status: `completed`, then **TodoWrite "Phase 1: Spawn dev with plan"** — status: `in_progress`.
5. TL validates the plan has all required fields (see format below)
6. TL evaluates the plan:
   - `BLOCKED=yes` → state Blocked, comment on issue, STOP
   - `BLOCKED=no` → proceed to Phase 2 (spawn dev with the plan)
   - Missing required fields → ask Planner to redo with specific gaps identified

### Plan Format

The planner's `plan.md` must include these sections: Language/Framework, Guidebooks, Type, Implementation Steps, Architectural Decisions, Edge Cases, Acceptance Criteria, Blocked. See the planner agent prompt for the full template.

### Edge Case: Planner Fails

If the Planner is unresponsive for >5 minutes or produces an unusable plan:
1. TL performs a quick analysis directly: read `CLAUDE.md`, scan the issue, identify key files
2. Produce a minimal plan (Implementation Steps + Acceptance Criteria + Type is enough)
3. Proceed to Phase 2 — spawn dev with the TL-produced plan
4. Do NOT spend more than a few minutes on this — a good-enough plan is better than a perfect one

---

## Phase 2 — Implementation

1. **TL spawns `fleet-dev`** with the planner's plan included in the task prompt (see Dev Task Format below)
2. Dev starts implementing immediately — it has the plan, guidebook paths, and all context it needs
3. Dev implements, tests locally, commits atomically
4. **Dev writes `changes.md`** to the worktree root using the Write tool (see Changes Report Format below) — summarizing what changed, decisions made, test results, and `git diff --stat` output
5. **Dev pings TL** via SendMessage: `"Ready for review. Branch: {branch}. Changes in changes.md."` — the message is just a ping, report content is in the file
6. TL reads `changes.md` (do NOT delete it) and transitions to Phase 3 — spawns reviewer with the changes report included in the spawn prompt
7. **TodoWrite "Phase 1: Spawn dev with plan"** — status: `completed`, then **TodoWrite "Phase 2: Spawn reviewer"** — status: `in_progress`.

### Planner Task Format (sent via TaskCreate at spawn)

Include these fields: ISSUE (`#{N} {title}`), PROJECT, ISSUE CONTEXT (full body from `.fleet-issue-context.md`), COMMENTS (all with author/date), LABELS, DEPENDENCIES. Add note: "You already have the full issue context above — start directly with codebase exploration."

If `.fleet-issue-context.md` was NOT available, omit the context fields and instead tell the planner: "Fetch the full issue via `gh issue view {N} --repo {repo} --json title,body,comments,labels`."

### Dev Task Format (sent via TaskCreate at spawn)

Include these fields: ISSUE (`#{N} {title}`), BRANCH (`{feat|fix|test}/{N}-{short-desc}`), BASE (`main`), ISSUE SUMMARY (1-3 sentences), ACCEPTANCE CRITERIA (bulleted), PLAN (full planner plan), GUIDEBOOKS (list of paths from plan). Dev reads CLAUDE.md + guidebooks, implements per plan, runs build + tests, commits atomically (`Issue #{N}: {desc}`), pushes, and pings TL.

### Changes Report Format (written by dev to `changes.md`)

Dev writes a summary including: what changed (files list with descriptions), any deviations from plan, test results (`npm test` + `tsc --noEmit`), known limitations, and `git diff --stat` output.

### Edge Case: Dev Gets Stuck

- FC's stuck detector will nudge TL if the team is idle too long
- TL checks if the dev agent is still active (TaskList)
- If dev is stuck: send a message with more context, hints, or simplified scope
- If dev is unresponsive after nudge: stop the dev agent, spawn a fresh one with additional context from the failed attempt

---

## Phase 3 — Review (Peer-to-Peer)

1. **TL reads `changes.md`** from the worktree root (written by dev). This contains the dev's change summary, decisions, test results, and diff stats. Do NOT delete it — it stays in `.gitignore`.
2. **TL spawns `fleet-reviewer`** with the branch name, issue context, guidebook paths, and the dev's changes report (see Reviewer Task Format below)
3. Reviewer starts reviewing immediately — it has all the context it needs, including the dev's own account of what changed and why
4. **Dev and reviewer already know each other's names** (set at spawn time). No TL introduction needed.
5. **TL steps back and WAITS for the reviewer's ping.** The dev-reviewer loop runs peer-to-peer:
   - Reviewer performs two-pass review (code quality + acceptance)
   - **REJECT** → reviewer sends actionable feedback directly to dev → dev fixes and re-requests review from reviewer directly
   - **APPROVE** → reviewer writes `review.md` using Write tool, pings TL: `"Review complete. Verdict in review.md."`
6. **TL does NOT proceed to PR creation until it receives the reviewer's ping AND `review.md` exists.** This is a hard requirement — no exceptions. Do NOT assume the review is done because the reviewer went quiet or exited.
7. TL does NOT intervene unless:
   - **3 review rounds exhausted** → TL arbitrates (see Error Handling)
   - **Escalation request** from either agent → TL steps in
   - **FC sends a nudge** → TL checks on the reviewer (see FC Messages below)

### Reviewer Task Format (sent via TaskCreate at spawn)

Include these fields: ISSUE (`#{N} {title}`), BRANCH, BASE (`main`), ACCEPTANCE CRITERIA (bulleted), CHANGES (full content from dev's `changes.md`), GUIDEBOOKS (list of paths from plan). Reviewer reads CLAUDE.md + guidebooks, verifies the dev's changes report against actual `git diff`, performs two-pass review (code quality + acceptance), sends REJECT feedback directly to dev via SendMessage, and writes final verdict to `review.md` then pings TL. Peer names: dev=`dev`, planner=`planner`. Max 3 review rounds; after 3rd round write `review.md` with CHANGES_NEEDED and wait for shutdown.

### TL Reads review.md

After receiving the reviewer's ping (`"Review complete. Verdict in review.md."`), the TL reads `review.md` from the worktree root. Do NOT delete it. The reviewer stays alive briefly for shutdown_request.

If the ping arrived but `review.md` does not exist, ask the reviewer via SendMessage to write it. If the reviewer has exited without writing it, respawn (within budget).

**NEVER proceed to PR creation without reading review.md.** No review.md = no PR.

1. **Read** `review.md` using the Read tool (do NOT delete it)
2. **Act on the verdict**:
   - `Status: APPROVE` → **TodoWrite "Phase 2: Spawn reviewer"** — status: `completed`, then **TodoWrite "Phase 3: Create PR and merge"** — status: `in_progress`. Proceed to Phase 4 (PR creation).
   - `Status: CHANGES_NEEDED` → relay the issues to the dev via SendMessage, dev fixes, and TL re-spawns the reviewer (or arbitrates if rounds are exhausted)

### TL Non-Intervention Rules

During the dev↔reviewer loop, TL MUST NOT:
- Relay messages between dev and reviewer (they talk directly)
- Ask "how's it going?" before an agent is stuck (10min)
- Override reviewer's verdict (until round 3 escalation)
- Tell dev to skip fixing a review comment
- Inject new requirements not in the original issue

TL MAY:
- Respond to FC messages (ci_red, nudge_stuck, etc.)
- Intervene on escalation from either agent
- Arbitrate after 3 failed review rounds
- Nudge an agent that has been idle for 5+ minutes

---

## Phase 4 — PR

After TL reads `review.md` with `Status: APPROVE`:

1. **Branch freshness check** (MANDATORY):
   ```bash
   git stash --include-untracked && git fetch origin main && git rebase origin/main && git stash pop && git push --force-with-lease
   ```
   The `git stash --include-untracked` is required because the CC runtime may leave unstaged changes (e.g., `.claude/settings.json`) that block rebase.
   If rebase fails (conflicts) → state Blocked.

2. **TL creates PR**:
   ```bash
   gh pr create --base main --title "Issue #{N}: {description}" --body "Closes #{N}"
   ```

3. **Set auto-merge immediately** (mandatory, no exceptions):
   ```bash
   gh pr merge {PR} --auto --squash --delete-branch
   ```

4. **STOP and wait for FC events via stdin** (MANDATORY — do NOT poll):
   After setting auto-merge, **stop all activity**. Do NOT run `gh pr view`, `gh pr checks`, or `ScheduleWakeup` to poll CI status. FC monitors CI every 30 seconds and delivers results directly to you via stdin:
   - `ci_green` or `ci_green_auto_shutdown` → merge is handled automatically → team shuts down
   - `ci_red` → forward failure details to dev → dev fixes and pushes → wait again
   - `ci_blocked` → too many CI failure types → state Blocked
   - `pr_merged` → state Done → close issue, shut down agents
   FC already polls GitHub every 30s. If you also poll, you burn tokens on redundant `gh` calls.

---

## Phase 5 — Done

0. **TodoWrite "Phase 3: Create PR and merge"** — status: `completed`.
1. Close issue: `gh issue close {N} --comment "Closed. PR #{PR} merged."`
2. **Explicit shutdown sequence** (MANDATORY):
   a. Run `TaskList` to identify all active subagents.
   b. For each active subagent, send `shutdown_request` via `TaskUpdate`.
   c. Run `TaskList` again to verify all subagents have exited.
   d. If any subagent is still running after shutdown_request, send a second shutdown_request, then proceed regardless.
3. TL finishes

---

## BLOCKED State

Entered from any phase when the team cannot proceed:
1. Comment on the issue explaining what blocks progress
2. Report blocker details to FC (visible in dashboard)
3. STOP all work — wait for PM instructions from FC dashboard

---

## FC Messages

Fleet Commander sends these messages directly to the TL via stdin. They arrive automatically — no polling needed.

| Message ID | When | Content |
|------------|------|---------|
| `ci_green` | CI passes on PR | "CI passed on PR #{PR}. All checks green. Auto-merge is {status}." |
| `ci_green_auto_shutdown` | CI green + auto-merge + clean | "CI passed, auto-merge enabled, no conflicts. Shut down immediately." |
| `ci_red` | CI fails on PR | "CI failed on PR #{PR}. Failing checks: {details}. Fix count: {N}/{max}." |
| `ci_blocked` | Too many CI failures | "STOP. {N} unique CI failure types on PR #{PR}. Wait for instructions." |
| `pr_merged` | PR is merged | "PR #{PR} merged. Close the issue, clean up, and finish." |
| `nudge_idle` | Team idle 5+ min | "FC status check: You've been idle for {N} minutes. If waiting for subagents, run TaskList to verify they are still active. If a phase just completed, proceed to the next step." |
| `nudge_stuck` | Team stuck 10+ min | "You appear stuck. Report status or ask for help." |
| `issue_comment_new` | New non-bot comment on issue | "New comment on issue #{KEY} by @{author}: {body}" |
| `issue_labels_changed` | Priority/blocking labels change | "Labels changed on issue #{KEY}: {added} added, {removed} removed." |
| `issue_closed_externally` | Issue closed outside team | "Issue #{KEY} was closed externally. Wrap up and shut down." |
| `issue_body_updated` | Issue description edited | "The description of issue #{KEY} has been updated. Review latest requirements." |

### TL Response to FC Messages

**On `ci_green`**: Acknowledge and wait for `pr_merged` or `ci_green_auto_shutdown` (auto-merge handles it).
**On `ci_green_auto_shutdown`**: Shut down all subagents immediately and exit. GitHub will merge the PR automatically.
**On `ci_red`**: Forward failure details to dev. Counts toward failure limit.
**On `ci_blocked`**: STOP all work. Wait for PM instructions.
**On `pr_merged`**: Close issue, shut down all agents (`shutdown_request`), finish.
**On `nudge_idle`**: First action: SendMessage to the active agent asking for status. Do NOT skip waiting for a deliverable or proceed without the required file. Only respawn if the agent has exited without delivering.
**On `nudge_stuck`**: Same as `nudge_idle` but more urgent. If no agent response after 2 minutes, check TaskList. If exited without deliverable, respawn (within budget). Do NOT skip phases.
**On `issue_comment_new`**: Forward new requirements/clarifications to dev if relevant. Ignore simple acknowledgments.
**On `issue_labels_changed`**: Check for priority shifts (`blocking`/`urgent`). If `blocked` added, investigate and report to FC.
**On `issue_closed_externally`**: Stop work, push pending changes, shut down all agents.
**On `issue_body_updated`**: Re-read requirements, forward to dev if they affect current work.

---

## Error Handling

### Agent Spawn Failure

Retry once (5 second wait). If retry fails, TL takes over that agent's role (analysis, implementation, or review). FC sees failures via hooks.

### Test Failure During Implementation

Dev runs tests before reporting ready and does NOT report with failing tests. If dev cannot fix after reasonable effort, dev reports blocker to TL who may assist or escalate.

### Review Loop Stuck (3 Rounds Exhausted)

After 3 REJECT rounds, TL arbitrates: override minor nits and proceed to PR, send specific guidance for one final attempt, or state Blocked if fundamentally broken.

### Dev and Reviewer Disagree

After round 2 with the same contested point, reviewer escalates to TL. TL reads the diff + feedback and arbitrates.

### CI Failure Handling

TL forwards `ci_red` details to dev. Same failure type does NOT count as a new unique failure. After 3 unique failure types, state Blocked (FC sends `ci_blocked`).

### Rebase Conflict

If rebase on `origin/main` fails with conflicts, state Blocked, comment on issue, and STOP.

---

## Branch Naming

The TL determines the branch name based on the issue type and provides it to the dev in the task prompt:

| Prefix | Use |
|--------|-----|
| `feat/{N}-{desc}` | New feature |
| `fix/{N}-{desc}` | Bug fix |
| `test/{N}-{desc}` | Test-only changes |

### Commit Format

```
Issue #{N}: {description}
```

Atomic commits — each commit should be a logical unit.

### Build Before Review

**MANDATORY before reporting "ready for review"**: dev must run the project build and any new tests locally. This prevents unnecessary review iteration.

---

## Rules

- **One issue at a time** — atomic changes only
- **CI must be green** — PR CANNOT be merged with red CI
- **Branch from main** — NEVER commit directly to main
- **TL creates the PR** — dev pushes code, TL creates the PR and sets auto-merge
- **P2P for review** — dev and reviewer talk directly, TL does not relay
- **Idle = normal** — agents waiting for messages are expected to be idle
- **TL intervenes only on escalation, stuck, or PR** — do not micromanage the dev↔reviewer loop
- **Respond to FC messages promptly** — FC messages arrive via stdin and require action
- **TL does not implement** — spawn subagents for all work (except planner fallback)
- **Planner failure is not fatal** — TL can produce a minimal plan if planner fails

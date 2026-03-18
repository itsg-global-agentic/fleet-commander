<!-- Fleet Commander workflow template. Installed by Fleet Commander into your project. -->
<!-- Placeholders {{PROJECT_NAME}}, {{project_slug}}, {{BASE_BRANCH}}, {{ISSUE_NUMBER}} are replaced during installation. -->

# Diamond Workflow — {{PROJECT_NAME}}

## About Fleet Commander

Fleet Commander (FC) is the orchestration layer that manages your team. Key facts:

- **Hooks** — FC monitors agent activity via hooks installed in the repo. Every tool use, session start/end, notification, and error is reported automatically. You do not need to report progress manually.
- **CI/PR updates via stdin** — FC watches GitHub for CI results and PR status. When something changes, FC sends a message directly to the Team Lead (TL) via stdin. No PR Watcher agent is needed.
- **Dashboard** — The PM watches all teams from the FC dashboard. They can see your state (Analyzing, Implementing, Reviewing, PR, Done, Blocked), recent events, and output in real time.
- **Messages from FC** — FC may send structured messages to the TL (see "FC Messages" section below). These arrive as stdin messages and should be acted on promptly.
- **Idle/Stuck thresholds** — FC marks agents idle after 3 minutes of inactivity and stuck after 5 minutes. Agents waiting for peer messages are expected to be idle — this is normal. TL should only intervene when stuck.

## Entry Point

```
User: claude --worktree {{project_slug}}-{N}
(prompt is sent via stdin from Fleet Commander's prompt file)
```

**Role of TL (main agent = You):**
1. Read this workflow and understand the team structure
2. Spawn `fleet-analyst` and send it the issue number
3. Wait for the Analyst's brief
4. Spawn `fleet-dev` with the brief + guidebook list (the TYPE field tells the dev which guidebooks to read)
5. Once dev reports "ready for review", spawn `fleet-reviewer`
6. Let dev and reviewer communicate peer-to-peer — DO NOT relay messages between them
7. Only intervene if: escalation after 3 review rounds, agent stuck (5min idle), or final PR creation
8. When review passes: rebase, create PR, set auto-merge
9. Respond to FC messages (ci_green, ci_red, pr_merged, nudge_idle, nudge_stuck)
10. On pr_merged: close issue, shut down agents, finish

## Team Composition — Diamond (3 Agents)

| Agent | subagent_type | name | Role | Spawn |
|-------|---------------|------|------|-------|
| **Analyst** | `fleet-analyst` | `analyst` | Analyzes issue + codebase, produces structured brief with guidebook paths | Phase 1 only |
| **Dev** | `fleet-dev` | `dev` | Implements code, writes tests, pushes commits. Reads guidebooks for specialization. Communicates with reviewer directly during review. | Phase 2 onward |
| **Reviewer** | `fleet-reviewer` | `reviewer` | Two-pass code review. Sends feedback directly to dev. Reports final verdict to TL. | Phase 3 onward |

There is NO coordinator agent. The TL orchestrates all three agents directly.

All agents use `model: inherit` — they run on the same model as the TL.

### Agent Lifecycle

- **Analyst** is spawned first and dismissed after delivering the brief. It does not persist.
- **Dev** is spawned after the brief and persists through implementation, review rounds, and CI fixes.
- **Reviewer** is spawned when dev reports "ready for review" and persists through all review rounds.
- Dev and Reviewer communicate **peer-to-peer** — TL does not relay messages between them.

### TYPE to Guidebook Mapping

All implementation work is assigned to the single `fleet-dev` agent. The Analyst's TYPE and Guidebooks fields tell the dev which guidebooks to read for domain-specific conventions.

| TYPE in brief | Guidebooks to read |
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
    [*] --> Analyzing : start (spawn analyst)
    Analyzing --> Implementing : brief OK (spawn dev)
    Analyzing --> Blocked : BLOCKED in brief
    Implementing --> Reviewing : dev reports "ready for review" (spawn reviewer)
    Reviewing --> Implementing : REJECT (dev fixes, max 3 rounds)
    Reviewing --> PR : APPROVE (TL creates PR)
    PR --> Done : CI GREEN + merge
    PR --> Implementing : CI RED (dev fixes, pushes)
    Implementing --> Blocked : escalation
    Reviewing --> Blocked : 3x REJECT
    PR --> Blocked : 3 unique CI failure types
    Done --> [*]
```

**Blocked can be entered from any active state** when the team cannot proceed (missing info, unresolvable conflicts, repeated failures).

---

## Phase 1 — Analysis

1. **TL spawns `fleet-analyst`** with the issue number
2. Analyst reads the issue, explores the codebase, discovers guidebooks, and produces a structured brief
3. Brief arrives via `SendMessage` from analyst to TL
4. TL validates the brief has all required fields (see format below)
5. TL evaluates the brief:
   - `BLOCKED=yes` → state Blocked, comment on issue, STOP
   - `BLOCKED=no` → proceed to Phase 2
   - Missing required fields → ask Analyst to redo with specific gaps identified

### Brief Format

The Analyst produces a brief in this format:

```
## Analysis Brief for Issue #{N}

### Language/Framework
{primary language} / {framework(s)}

### Guidebooks
- {path/to/guidebook1.md}
- {path/to/guidebook2.md}
- (none found)

### Type
{single | mixed} — {developer mapping}

### Key Files
- {path} — {what changes and why}

### What Needs to Change
{Detailed analysis with implementation approach}

### Risks
- {specific risk or edge case}

### Blocked
no | yes — {reason}
```

### Edge Case: Analyst Fails

If the Analyst is unresponsive for >5 minutes or produces an unusable brief:
1. TL performs a quick analysis directly: read `CLAUDE.md`, scan the issue, identify key files
2. Produce a minimal brief (Key Files + What Needs to Change + Type is enough)
3. Proceed to Phase 2 with the self-generated brief
4. Do NOT spend more than a few minutes on this — a good-enough brief is better than a perfect one

---

## Phase 2 — Implementation

1. **TL spawns `fleet-dev`** with the brief and guidebook list (the TYPE field determines which guidebooks the dev should read)
2. **TL spawns the dev agent** with this context in the task:
   - The full Analyst brief
   - The list of guidebook paths from the brief (dev reads these first)
   - The target branch name (see Branch Naming below)
   - Issue number and title
3. Dev reads guidebooks, implements, tests locally, commits atomically
4. Dev reports to TL: "Ready for review. Branch: `{branch}`"
5. TL transitions to Phase 3

### Dev Task Format (sent via TaskCreate)

```
ISSUE: #{N} {title}
BRANCH: {feat|fix|test}/{N}-{short-desc}
BASE: {{BASE_BRANCH}}

BRIEF:
{paste the full analyst brief here}

GUIDEBOOKS (read these before implementing):
{list of paths from brief}

INSTRUCTIONS:
1. Read each guidebook file listed above
2. Implement the changes described in the brief
3. Follow conventions from CLAUDE.md
4. Run build + tests locally before reporting ready
5. Commit atomically: "Issue #{N}: {description}"
6. Report "Ready for review. Branch: {branch}" when done
```

### Mixed-Language Work

For mixed-type issues (e.g., C# backend + TypeScript frontend):
1. Spawn the primary dev first (larger scope)
2. When primary dev completes, spawn secondary dev with `blockedBy` dependency
3. Wait for both to complete before review

### Edge Case: Dev Gets Stuck

- FC's stuck detector will nudge TL if the team is idle too long
- TL checks if the dev agent is still active (TaskList)
- If dev is stuck: send a message with more context, hints, or simplified scope
- If dev is unresponsive after nudge: stop the dev agent, spawn a fresh one with additional context from the failed attempt

---

## Phase 3 — Review (Peer-to-Peer)

1. **TL spawns `fleet-reviewer`** with the branch name and issue number
2. **TL tells dev**: "Reviewer is available as `reviewer`. When review feedback arrives, address it and re-request review directly."
3. **TL tells reviewer**: "Dev is available as `dev`. Send rejection feedback directly to dev. Send your final APPROVE/REJECT verdict to me (TL)."
4. **TL steps back.** The dev↔reviewer loop runs peer-to-peer:
   - Reviewer performs two-pass review (code quality + acceptance)
   - **REJECT** → reviewer sends actionable feedback directly to dev → dev fixes and re-requests review from reviewer directly
   - **APPROVE** → reviewer notifies TL with the final verdict
5. TL monitors but does NOT intervene unless:
   - **3 review rounds exhausted** → TL arbitrates (see Error Handling)
   - **Agent stuck** (5min idle) → TL sends a nudge
   - **Escalation request** from either agent → TL steps in

### Reviewer Task Format (sent via TaskCreate)

```
ISSUE: #{N} {title}
BRANCH: {branch-name}
BASE: {{BASE_BRANCH}}

Review the changes on this branch against the base branch.
Two-pass review: code quality + acceptance criteria from the issue.

PEERS:
- Dev agent name: {dev-agent-name}
- Send rejection feedback DIRECTLY to dev via SendMessage
- Send final APPROVE or REJECT verdict to TL (me)

If you reject, include a numbered list of specific, actionable fixes with file:line references.
Dev will fix and message you directly when ready for re-review.
Max 3 review rounds total (initial + 2 re-reviews).
After 3rd rejection, report BLOCKED to TL.
```

### TL Non-Intervention Rules

During the dev↔reviewer loop, TL MUST NOT:
- Relay messages between dev and reviewer (they talk directly)
- Ask "how's it going?" before an agent is stuck (5min)
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

After reviewer sends APPROVE to TL:

1. **Branch freshness check** (MANDATORY):
   ```bash
   git fetch origin {{BASE_BRANCH}} && git rebase origin/{{BASE_BRANCH}} && git push --force-with-lease
   ```
   If rebase fails (conflicts) → state Blocked.

2. **TL creates PR**:
   ```bash
   gh pr create --base {{BASE_BRANCH}} --title "Issue #{N}: {description}" --body "Closes #{N}"
   ```

3. **Set auto-merge immediately** (mandatory, no exceptions):
   ```bash
   gh pr merge {PR} --auto --squash --delete-branch
   ```

4. Wait for FC to send CI status via stdin:
   - `ci_green` → auto-merge handles merge → wait for `pr_merged`
   - `ci_red` → TL forwards failure details to dev → dev fixes and pushes
   - After 3 unique CI failure types → state Blocked (FC sends `ci_blocked`)
   - `pr_merged` → state Done

---

## Phase 5 — Done

1. Close issue: `gh issue close {N} --comment "Closed. PR #{PR} merged."`
2. `shutdown_request` to all active subagents → wait for `shutdown_response`
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
| `ci_red` | CI fails on PR | "CI failed on PR #{PR}. Failing checks: {details}. Fix count: {N}/{max}." |
| `ci_blocked` | Too many CI failures | "STOP. {N} unique CI failure types on PR #{PR}. Wait for instructions." |
| `pr_merged` | PR is merged | "PR #{PR} merged. Close the issue, clean up, and finish." |
| `nudge_idle` | Team idle 3+ min | "You have been idle for a while. What is the status?" |
| `nudge_stuck` | Team stuck 5+ min | "You appear stuck. Report status or ask for help." |

### TL Response to FC Messages

**On `ci_green`**: Auto-merge will handle the merge. Acknowledge and wait for `pr_merged`.

**On `ci_red`**: Forward failure details to dev. Dev fixes and pushes. This counts toward the failure limit.

**On `ci_blocked`**: STOP all work. Wait for PM instructions from the dashboard.

**On `pr_merged`**: Close the issue, shut down agents (`shutdown_request` to all), finish.

**On `nudge_idle`**: Report current status to FC. If waiting for a subagent, check on them.

**On `nudge_stuck`**: Check which agent is stuck. Send a targeted nudge. If no progress after nudge, escalate to FC by reporting status.

---

## Error Handling

### Agent Spawn Failure

If spawning any agent fails:
1. **Retry once** — wait 5 seconds, attempt spawn again
2. **If retry fails** — TL takes over that agent's role:
   - Analyst fails → TL does the analysis themselves
   - Dev fails → TL implements the code themselves
   - Reviewer fails → TL reviews the code themselves (still two-pass)
3. Log the failure for FC visibility (FC sees it via hooks)

### Test Failure During Implementation

1. Dev runs tests locally before reporting "ready for review"
2. If tests fail → dev fixes and re-runs until green
3. Dev does NOT report "ready for review" with failing tests
4. If dev cannot fix tests after reasonable effort → dev reports blocker to TL → TL may assist or escalate

### Review Loop Stuck (3 Rounds Exhausted)

After 3 review rounds (initial + 2 fix rounds) with REJECT:
1. Reviewer sends `BLOCKED — 3 review rounds exhausted` to TL
2. TL reads the latest rejection feedback and the current code
3. TL arbitrates:
   - If remaining issues are minor nits → TL overrides and proceeds to PR
   - If remaining issues are substantive → TL sends specific guidance to dev for one final attempt
   - If fundamentally broken → state Blocked, comment on issue

### Dev and Reviewer Disagree

If the same issue bounces back and forth between dev and reviewer:
- After round 2, if the same point is still contested, reviewer escalates to TL
- TL reads the diff and the reviewer's feedback
- TL arbitrates: either side with the reviewer (dev must fix) or override the reviewer (approve with noted exception)

### CI Failure Handling

1. `ci_red` received → TL forwards failure details to dev
2. Dev fixes the failing tests/checks and pushes
3. Progress on the same failure type does NOT count as a new unique failure
4. After 3 unique failure types → state Blocked (FC sends `ci_blocked`)

### Rebase Conflict

1. If `git rebase origin/{{BASE_BRANCH}}` fails with conflicts → state Blocked
2. Comment on issue explaining the conflict
3. STOP — do not attempt manual conflict resolution across worktrees

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
- **Branch from {{BASE_BRANCH}}** — NEVER commit directly to {{BASE_BRANCH}}
- **TL creates the PR** — dev pushes code, TL creates the PR and sets auto-merge
- **P2P for review** — dev and reviewer talk directly, TL does not relay
- **Idle = normal** — agents waiting for messages are expected to be idle
- **TL intervenes only on escalation, stuck, or PR** — do not micromanage the dev↔reviewer loop
- **Respond to FC messages promptly** — FC messages arrive via stdin and require action
- **TL does not implement** — spawn subagents for all work (except analyst fallback)
- **Analyst failure is not fatal** — TL can produce a minimal brief if analyst fails

## Anti-Patterns

| Wrong | Right |
|-------|-------|
| TL relays messages between dev and reviewer | Dev and reviewer talk directly (p2p) |
| TL asks "how's it going?" every minute | Wait for report or 5min stuck threshold |
| TL implements code while dev is active | Let dev do the implementation |
| TL overrides reviewer without reading feedback | Read feedback, arbitrate only after 3 rounds |
| Dev pushes without local tests | Build + tests locally BEFORE reporting ready |
| Dev pushes without rebase | ALWAYS rebase on {{BASE_BRANCH}} before push |
| Dev creates the PR | TL creates the PR after APPROVE |
| Spawning a coordinator / 4th agent | Diamond team is exactly 3 agents: analyst, dev, reviewer |
| Spawning all agents at once | Spawn each agent when its phase begins |
| Ignoring FC messages | Always respond to ci_green, ci_red, pr_merged, nudges |
| Respawning agent after 2 min idle | Idle is normal — only act at 5min stuck threshold |
| TL monitors CI manually | FC handles CI monitoring and sends updates via stdin |

## Decision Summary

```
Phase 1: TL → spawn Analyst → receive brief → validate
Phase 2: TL → spawn Dev (fleet-dev + guidebooks from brief) → dev implements → dev reports "ready for review"
Phase 3: TL → spawn Reviewer → reviewer + dev iterate p2p → reviewer reports verdict to TL
Phase 4: TL → rebase → create PR → set auto-merge → FC monitors CI
Phase 5: TL → close issue → shutdown agents → finish
```

Edge cases:
- Analyst fails → TL does quick analysis themselves
- Dev stuck → TL nudges, then restarts with more context
- 3 rejections → TL arbitrates: simplify, override nits, restart dev, or abort
- Dev/Reviewer disagree → TL arbitrates after round 2
- CI blocked → STOP, wait for PM

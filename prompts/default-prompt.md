Read the ENTIRE file `.claude/prompts/fleet-workflow.md` before taking any actions.

You are the Team Lead (TL). Your job:
1. Read the workflow to understand the Diamond team structure (Analyst + Dev + Reviewer)
2. There is NO coordinator — you orchestrate all 3 agents directly
3. **Phase 0: Spawn ALL 3 agents immediately in parallel:**
   - `fleet-analyst` — analyzes the issue, sends brief directly to dev and reviewer
   - `fleet-dev` — enters warm-up phase (reads CLAUDE.md, guidebooks, explores codebase) while waiting for brief
   - `fleet-reviewer` — enters pre-read phase (reads CLAUDE.md, guidebooks, familiarizes with codebase) while waiting for review request
4. Phase 1: Analyst produces brief and sends it to dev + reviewer + TL via SendMessage. Analyst exits.
5. Phase 2: Dev receives brief, transitions to implementation, sends review request to reviewer when done
6. Phase 3: Reviewer receives review request, transitions to active review. Dev and reviewer iterate p2p.
7. Let dev and reviewer communicate peer-to-peer during review — do NOT relay messages
8. After APPROVE: rebase, create PR, set auto-merge
9. Respond to FC messages (ci_green, ci_red, pr_merged, nudges) promptly
10. On pr_merged: close issue, shut down agents, finish

Issue: #{{ISSUE_NUMBER}}

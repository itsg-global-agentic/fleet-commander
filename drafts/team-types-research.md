# Team Types Research — Draft

## Research output from 10 human collaboration methods analyzed for AI agent adaptation

### Top 3 (after Diamond)

1. **Code Review Circle** — 3-4 parallel specialized reviewers + aggregator. Score 16/20.
2. **Red Team / Blue Team** — adversarial build/break cycles. Score 14/20.
3. **Six Thinking Hats** — 5 perspective agents for decision-making. Score 14/20.

### Known constraint: no group communication primitive

CC SendMessage supports:
- `to: "agent-name"` — direct message (p2p)
- `to: "*"` — broadcast to ALL teammates

Missing:
- No channel/group concept (can't send to "all reviewers" or "all hats except Blue")
- No subscribe/topic model
- No shared state/blackboard that multiple agents read from

**Impact on team designs:**
- **Six Hats:** Each hat must send perspective to TL (Blue Hat). TL aggregates. Hub-spoke, not round-table.
- **Code Review Circle:** Each reviewer sends verdict to TL/aggregator. No reviewer-to-reviewer discussion.
- **Red/Blue Team:** Red and Blue talk through TL/Commander. No direct Red↔Blue debate.
- **Brainwriting:** Ideas pass through TL for relay to next writer. No direct Writer→Writer handoff.

**Workarounds:**
1. TL as relay hub (current approach — works but adds latency and tokens)
2. `to: "*"` broadcast + agents filter by relevance (noisy, all agents see all messages)
3. Shared file as blackboard — agents write to a shared .md file, others Read it (hacky but works)
4. Sequential instead of parallel — eliminates need for group comms at cost of speed

### Full analysis

See: agent research output (10 methods with scoring matrix, agent mappings, communication patterns, feasibility assessment, sources)

### Team type roadmap (proposed)

| Priority | Type | Pattern | Use case |
|----------|------|---------|----------|
| P0 (done) | Diamond | dev team | GitHub issues → PRs |
| P1 | Six Thinking Hats | deliberation | Architecture decisions, tech eval |
| P2 | Red/Blue Team | adversarial | Security review, stress testing |
| P3 | Code Review Circle | parallel review | Critical PRs (as Diamond upgrade) |
| P4 | Brainwriting | ideation | Solution exploration |
| P5 | War Room | incident response | Production bugs |

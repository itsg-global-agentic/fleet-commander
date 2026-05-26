# Fleet Commander as a Claude Code Plugin — Design Analysis

**Date:** 2026-05-26
**Status:** Research / proposal (no implementation yet)
**Related issue:** #738

---

## Summary

This document evaluates whether Fleet Commander (FC) can ship as a Claude Code (CC) plugin
instead of using the current per-project `scripts/install.sh` / `install.ps1` flow.
Sources: `code.claude.com/docs/en/plugins`, `plugins-reference`, `plugin-marketplaces`,
`discover-plugins` (CC v2.1.142, May 2026 docs revision).

**Conclusions in one paragraph.** A CC plugin can absorb most of what `install.sh`
does today — hook entries, MCP server registration, agent templates, the workflow
prompt, and the guidebooks — and gives users a one-line install (`/plugin install
fleet-commander@hubertciebiada-plugins`) plus automatic updates. However, three
non-trivial pieces of FC's install do **not** map cleanly to the plugin model:
(1) the per-repo placeholder substitution in `templates/workflow.md` and the agent
templates (`{{PROJECT_NAME}}`, `{{project_slug}}`, `{{BASE_BRANCH}}`); (2) the
`.gitignore` mutation that prevents FC-managed files from being committed; and
(3) the assumption that the central Fastify HTTP server at port 4680 is what
ingests hook events. Plugin **monitors** specifically cannot replace
`POST /api/events` — monitor stdout is delivered to the local CC session that
spawned the monitor, not to a central HTTP collector. Recommendation: a phased
adoption that ships a plugin variant in parallel with the install script first,
then closes the residual gaps with a small `fleet-commander init` subcommand,
and only retires `scripts/install.sh` once both paths have proven parity.

**Headline conclusions:**

- A `plugin.json` with `hooks`, `mcpServers`, `agents`, and `skills` replaces the
  majority of the install script.
- Plugin monitors are an interesting **complement** to hook-based event
  reporting — they let an agent watch a file/process and react in-session — but
  they do **not** replace the central event collector that aggregates events
  across all teams.
- The placeholder substitution step (`templates/workflow.md` and agent
  templates) is the single biggest blocker to a pure-plugin install.
- A marketplace at a sibling repo (for example `github.com/hubertciebiada/fleet-commander-plugin`)
  is the cleanest distribution path; a fleet-commander plugin can also be
  loaded locally with `claude --plugin-dir ./fleet-commander-plugin` (CC 2.1.128+)
  for dogfooding without touching `~/.claude/`.
- Net result: the install simplification is real, but the FC server (Fastify
  on port 4680) is still required. The plugin replaces the **installer**, not
  the **server**.

---

## Background: what FC installs today

`scripts/install.sh` and the PowerShell wrapper `scripts/install.ps1` execute
seven numbered steps against a target repo. They are the authoritative source
for what a plugin would have to reproduce. The matching uninstall lives in
`scripts/uninstall.sh`.

| # | Step | Source in FC | Destination in target repo | Per-repo customization? |
|---|------|--------------|----------------------------|-------------------------|
| 1 | Copy hook scripts | `hooks/*.sh` (14 files) | `.claude/hooks/fleet-commander/` | No — same bytes everywhere |
| 2 | Merge hook entries into `settings.json` | `hooks/settings.json.example` (12 hook entries + `enabledPlugins`) | `.claude/settings.json` | No — same JSON merged in |
| 3 | Install workflow prompt with placeholder replacement | `templates/workflow.md` | `.claude/prompts/fleet-workflow.md` | **Yes** — `{{PROJECT_NAME}}`, `{{project_slug}}`, `{{BASE_BRANCH}}` |
| 4 | Install agent templates with placeholder replacement | `templates/agents/*.md` | `.claude/agents/` | **Yes** — same placeholders |
| 5 | Install guidebooks | `templates/guides/*.md` (8 files) | `.claude/guides/` | No — copied unchanged |
| 6 | Clean up retired agent template filenames | n/a | `.claude/agents/` | No — pure deletion |
| 7 | Append entries to `.gitignore` | hardcoded list of 11 paths | `.gitignore` | No — fixed list |

Two additional facts about runtime that are easy to miss:

- The FC server runs out-of-tree, on port 4680, and is **not** installed by
  `install.sh`. The script's job is to wire the *target repo* up to talk to a
  server that the user has already started elsewhere (`fleet-commander.bat`,
  `npm start`, etc.).
- An MCP server is also exposed (`bin/fleet-commander-mcp.js`), but it is
  invoked via the user's own `.mcp.json` — it is not installed into the target
  repo by `install.sh`.

The hook entries written into `settings.json` (step 2) all share the form:

```json
{
  "type": "command",
  "command": "bash .claude/hooks/fleet-commander/run-hook.sh tool_use on_post_tool_use.sh"
}
```

Inside `run-hook.sh`, the hook receives the CC stdin JSON on its stdin,
forwards it to `send_event.sh`, which POSTs it to
`${FLEET_SERVER_URL:-http://localhost:4680/api/events}` with a 2-second timeout
and exits 0 unconditionally. The hook itself is fire-and-forget — it must
never block CC.

---

## CC plugin capabilities (v2.1.105 through v2.1.142)

A plugin is "a self-contained directory of components that extends Claude Code
with custom functionality. Plugin components include skills, agents, hooks,
MCP servers, LSP servers, and monitors" (plugins-reference, CC v2.1.142).

The plugin manifest lives at `.claude-plugin/plugin.json`. Components live at
the plugin root, not inside `.claude-plugin/`. The full set of top-level
manifest fields relevant to FC:

| Manifest field | Replaces an FC install step? | Notes |
|----------------|------------------------------|-------|
| `name`, `version`, `description`, `author` | n/a | Metadata. `displayName` requires CC v2.1.143+. |
| `hooks` (or default `hooks/hooks.json`) | Replaces step 2's hook entries verbatim. | Format is the same JSON CC consumes from `settings.json`. |
| `mcpServers` (or default `.mcp.json`) | Replaces user-side `.mcp.json` editing. | `${CLAUDE_PLUGIN_ROOT}` resolves to the plugin's install path, so `node ${CLAUDE_PLUGIN_ROOT}/bin/fleet-commander-mcp.js` works without the user knowing where the plugin landed. |
| `agents` (or default `agents/`) | Replaces step 4 — but loses placeholder substitution. | Plugin agents support `name`, `description`, `model`, `effort`, `maxTurns`, `tools`, `disallowedTools`, `skills`, `memory`, `background`, `isolation`. They do **not** support `hooks`, `mcpServers`, or `permissionMode` (security restriction). |
| `commands` / `skills` (or default `commands/`, `skills/`) | Potential new home for guidebooks (step 5). | A skill is a directory with `SKILL.md`; a command is a single Markdown file. |
| `outputStyles` | Not applicable. | FC has no output styles. |
| `lspServers` (or default `.lsp.json`) | Not applicable. | LSP integration was added in CC 2.1.142 (single-skill plugin auto-load also in 2.1.142). FC has no LSP. |
| `experimental.themes` | Not applicable. | FC dashboard is a React app, not a CC theme. |
| `experimental.monitors` (or default `monitors/monitors.json`) | See §3 — does **not** replace the event collector. | Plugin monitors require CC v2.1.105 or later. |
| `userConfig` | Potential replacement for env vars / `FLEET_SERVER_URL`. | Values become `${user_config.KEY}` substitution and `CLAUDE_PLUGIN_OPTION_<KEY>` env vars in subprocesses. |
| `bin/` | Could ship `fleet-commander` CLI itself. | Files placed in `bin/` are added to the Bash tool's `PATH` while the plugin is enabled. |
| `settings.json` (at plugin root) | Limited. | Only the `agent` and `subagentStatusLine` keys are honored. Cannot ship arbitrary env / hooks here. |
| `dependencies` | Useful if FC depended on another plugin. | Not relevant today. |

Variable substitution is available in hook commands, monitor commands, MCP
server configs, and LSP server configs:

- `${CLAUDE_PLUGIN_ROOT}` — absolute path to the installed plugin directory.
- `${CLAUDE_PLUGIN_DATA}` — persistent directory (`~/.claude/plugins/data/{id}/`)
  that survives plugin updates. Suitable for `node_modules`, caches, etc.
- `${CLAUDE_PROJECT_DIR}` — the project root that CC was launched against
  (the same path CC sets as the `CLAUDE_PROJECT_DIR` env var for hooks).
- `${user_config.KEY}` — value of a `userConfig` field.
- `${ENV_VAR}` — any environment variable.

Two CLI flags matter for FC's development workflow:

- `claude --plugin-dir ./fleet-commander-plugin` (CC 2.1.128+ also accepts a
  `.zip` archive). Loads a local plugin for one session without installing it.
  Useful for FC dogfooding — change a file, run `/reload-plugins`, observe.
- `claude plugin validate ./fleet-commander-plugin [--strict]` — validates
  `plugin.json`, skill/agent/command frontmatter, and `hooks/hooks.json`.
  `--strict` treats unrecognized-field warnings as errors. Use in CI.

The same docs note that `claude plugin prune` (auto-remove orphaned plugin
dependencies) requires CC v2.1.121 or later.

---

## Question 1: Can a `plugin.json` replace `install.sh`?

**Direct answer: Mostly yes — about 60% of `install.sh` collapses into the
manifest. The remaining 40% is the per-repo placeholder substitution and the
`.gitignore` mutation, both of which a plugin cannot do on its own.**

| `install.sh` step | Plugin equivalent | Gap |
|-------------------|-------------------|-----|
| 1. Copy hook scripts to `.claude/hooks/fleet-commander/` | `hooks/` directory in the plugin, plus hook entries in `hooks/hooks.json` that reference `${CLAUDE_PLUGIN_ROOT}/hooks/...`. Hook scripts never need to be copied into the user's repo. | None. Clean replacement. The version-stamping `sed` (`# fleet-commander v...`) becomes unnecessary because the script lives inside the versioned plugin install. |
| 2. Merge hook entries into `.claude/settings.json` | `hooks` field in `plugin.json` (or `hooks/hooks.json`). CC merges these automatically when the plugin is enabled. | None. Cleaner: no risk of corrupting the user's existing `settings.json`. Uninstall no longer needs to parse and filter. |
| 3. Install workflow prompt with `{{PROJECT_NAME}}`, `{{project_slug}}`, `{{BASE_BRANCH}}` substitution | Plugin can ship a static `templates/workflow.md`, but CC **does not** substitute `{{...}}` placeholders. | **Gap.** Options: (a) compute the substitutions at runtime inside `team-manager.ts` when the team is launched (already true for `{{ISSUE_NUMBER}}` — extend it to `{{PROJECT_NAME}}` etc.); (b) ship a one-time `claude /plugin:fleet-commander:init` skill that runs the substitution; (c) push placeholder values into env vars (`FLEET_PROJECT_NAME`, `FLEET_PROJECT_SLUG`, `FLEET_BASE_BRANCH`) and reference `${FLEET_PROJECT_NAME}` from the workflow file. Option (a) is the lowest-friction migration because FC already owns `team-manager.ts`. |
| 4. Install agent templates with placeholder substitution | `agents/` directory in the plugin. Same placeholder gap as step 3. | Same. The agent files would need to either ship without placeholders (and have FC inject context another way) or be regenerated at team-launch time. |
| 5. Install guidebooks | Two options: (a) `skills/<guide-name>/SKILL.md` per guide (Claude can invoke each guide as a skill); (b) ship guidebooks as supporting files alongside a single skill — for example `skills/guidebooks/SKILL.md` references the bundled `*.md` files. (a) is more idiomatic; (b) is closer to today's "read `.claude/guides/foo.md`" flow. | None blocking. The "do not overwrite repo-local guides" rule from `install.sh` is preserved trivially: repo-local `.claude/skills/` overrides plugin skills because CC merges plugin skills into the same namespace. |
| 6. Clean up retired agent template filenames | Plugin install replaces a previous plugin install. Old files are not retained in the cache. | None. CC's plugin cache handles this. |
| 7. Append entries to `.gitignore` | **Plugins cannot mutate `.gitignore`.** | **Gap.** The plugin needs to either (a) document the required entries in a README and let users copy them in; (b) ship a `claude /plugin:fleet-commander:init` skill that appends to `.gitignore`; or (c) make FC's server tolerate dirty workspaces (it already does — these entries are quality-of-life, not correctness). Option (b) is the cleanest one-line user experience. |

So about 4 of 7 steps disappear entirely (1, 2, 5, 6), 2 of 7 need a runtime
workaround for placeholder substitution (3, 4), and 1 of 7 needs an explicit
init skill (7).

A plugin replaces **the installer**, not the install logic. The substitution
and `.gitignore` work still has to live somewhere — either pushed into
`team-manager.ts` at team-launch time, or wrapped in a small skill the user
invokes once per project. Either is feasible.

### Illustrative manifest

What a `plugin.json` would look like (shown for illustration only — this
document does not propose creating it):

```json
{
  "name": "fleet-commander",
  "displayName": "Fleet Commander",
  "version": "0.1.0",
  "description": "Orchestration scaffolding for multi-agent CC teams.",
  "author": {
    "name": "Hubert Ciebiada",
    "url": "https://github.com/hubertciebiada"
  },
  "homepage": "https://github.com/hubertciebiada/fleet-commander",
  "repository": "https://github.com/hubertciebiada/fleet-commander-plugin",
  "license": "Apache-2.0",
  "keywords": ["agent-orchestration", "claude-code"],
  "userConfig": {
    "server_url": {
      "type": "string",
      "title": "Fleet Commander server URL",
      "description": "Endpoint where hook events are posted",
      "default": "http://localhost:4680/api/events"
    }
  },
  "hooks": "./hooks/hooks.json",
  "mcpServers": "./.mcp.json",
  "agents": "./agents",
  "skills": "./skills"
}
```

The `hooks/hooks.json` would mirror the existing `hooks/settings.json.example`,
with one change: every `command` resolves through `${CLAUDE_PLUGIN_ROOT}` so
the user never sees a copied script:

```json
{
  "hooks": {
    "PostToolUse": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "bash \"${CLAUDE_PLUGIN_ROOT}\"/hooks/run-hook.sh tool_use on_post_tool_use.sh"
          }
        ]
      }
    ]
  }
}
```

The `.mcp.json` would point at the bundled MCP binary:

```json
{
  "mcpServers": {
    "fleet-commander": {
      "command": "node",
      "args": ["${CLAUDE_PLUGIN_ROOT}/bin/fleet-commander-mcp.js"]
    }
  }
}
```

---

## Question 2: Marketplace distribution

**Direct answer: A separate sibling repo, hosted as a marketplace via
`marketplace.json`, is the cleanest path. Public discoverability is a bonus
but not the main reason — the main reason is that CC's marketplace tooling
gives users automatic updates and a single install command.**

A marketplace is a git repository with `.claude-plugin/marketplace.json` at
its root. The file lists one or more plugins and where to fetch them. Users
add the marketplace once (`/plugin marketplace add <repo>`) and then install
individual plugins (`/plugin install <plugin>@<marketplace>`).

### Three install scopes (plugins-reference)

| Scope | Settings file | Use case for FC |
|-------|---------------|-----------------|
| `user` | `~/.claude/settings.json` | Personal install — every project the user opens has FC available |
| `project` | `.claude/settings.json` (committed) | Team install — committing `.claude/settings.json` opts every contributor in |
| `local` | `.claude/settings.local.json` (gitignored) | One-off / experimental install |

The CLI form is `claude plugin install fleet-commander@hubertciebiada-plugins
--scope project` (default scope is `user`). Inside an interactive session
the equivalent is `/plugin install fleet-commander@hubertciebiada-plugins`.

### Three distribution paths

| Path | What it looks like | When to use |
|------|--------------------|-------------|
| Public marketplace at `github.com/hubertciebiada/fleet-commander-plugin` | One repo, one marketplace, one plugin. Users run `/plugin marketplace add hubertciebiada/fleet-commander-plugin` then `/plugin install fleet-commander@fleet-commander-plugin`. | Recommended starting point. Anyone can subscribe; updates flow on `git push`. |
| Public catalog inclusion (`anthropics/claude-plugins-community`) | Submit through the in-app form (`claude.ai/settings/plugins/submit`). The official community catalog pins to a specific commit SHA and syncs nightly. | Once the plugin is stable. Higher discoverability, but Anthropic-pinned to specific commits, so updates take longer to propagate. |
| Private marketplace (any git host with restricted access) | Same `marketplace.json` schema, but the repo is private. Users add it with `/plugin marketplace add git+ssh://internal/fleet-plugin`. | Enterprise / internal deployments. |

The local dev path is `claude --plugin-dir ./fleet-commander-plugin`. This
loads the plugin from a relative directory for one session, without writing
anything to `~/.claude/`. It accepts a `.zip` archive (CC 2.1.128+) and can
be passed multiple times to layer several plugins.

### Why a separate sibling repo, not the FC repo itself

A `claude plugin validate --strict` pass against the FC repo would have to
ignore everything outside the plugin directory. Mixing a plugin manifest into
the existing FC repo also confuses contributors — the FC repo is a Node app,
not a plugin. A sibling repo (`fleet-commander-plugin`) keeps each repo doing
one thing.

The sibling repo can either bundle FC's hook scripts and templates verbatim,
or — preferred — install `fleet-commander-ai` from npm as a dependency
inside the plugin's own `${CLAUDE_PLUGIN_DATA}` and reference the resulting
binaries via `${CLAUDE_PLUGIN_DATA}/node_modules/.bin/fleet-commander-mcp`.
The docs show a pattern for installing `node_modules` on first run using a
`SessionStart` hook that compares the plugin-bundled `package.json` to the
copy in `${CLAUDE_PLUGIN_DATA}` and re-installs when they differ. FC's
plugin can use the same trick.

---

## Question 3: Can monitors replace the event collector?

**Direct answer: No. Monitors are session-local notification streams; the
event collector is a central HTTP service across many teams. They solve
different problems.**

This is the central technical finding of this analysis and the easiest one
to misread. The plugins-reference is explicit:

> "Each [monitor] runs a shell command for the lifetime of the session and
> delivers every stdout line to Claude as a notification, so Claude can
> react to log entries, status changes, or polled events without being
> asked to start the watch itself."
>
> — `code.claude.com/docs/en/plugins-reference`, "Monitors" section

The stdout from a monitor goes to **Claude inside the same session that
started the monitor**, as a notification. It does **not** post anywhere. It
does not aggregate across sessions. Two sessions running the same plugin
each get their own copy of every monitor and their own notification stream.

### Why this matters for FC

FC's event collector is fundamentally a **cross-team aggregator**:

```
   team A (worktree A)                team B (worktree B)             team C (worktree C)
   .claude/hooks/...                  .claude/hooks/...                .claude/hooks/...
        |                                  |                                |
        v                                  v                                v
   POST /api/events                   POST /api/events                 POST /api/events
        \                                  |                                /
         \                                 |                               /
          \                                v                              /
           +------------>  Fleet Commander Fastify server (port 4680)  <-+
                          - event-collector.ts (DB insert + state machine)
                          - sse-broker.ts (broadcast to dashboard clients)
                          - github-poller.ts (PR / CI / merge)
                          - stuck-detector.ts (idle / stuck timers)
                          - usage-tracker.ts (CC usage snapshots)
                          - SQLite at fleet.db (14 tables)
                          - React dashboard at http://localhost:4680
```

Monitors would only re-arrange the leftmost column:

```
   team A's session
        |
   /plugin (Fleet Commander) auto-arms a monitor
        |
   monitor command runs inside team A's CC process
        |
   stdout -->  team A's own notification queue   (NOT a server)
```

There is no cross-team aggregation, no DB, no SSE fan-out, no dashboard.
Team B's session has no idea team A's monitor is running.

To make monitors usable as the event collector, the monitor's command would
have to itself POST to a central server — i.e. it would be the same shell
hook architecture FC has today, just running as a long-lived process instead
of being re-invoked on each CC event. That is not a win. It is the same
architecture in a different vehicle.

### Where monitors could complement, not replace, FC

Plugin monitors are still genuinely useful inside FC's design — just not at
the level of the event collector. Examples of monitors that would add value
**inside a single team's session**:

- A `pr-status` monitor that polls `gh pr checks` for the team's open PR
  and pushes status changes into the TL's notification queue. This is
  cleaner than today's `FC->TL via stdin` flow because the notification
  arrives natively. (Note: this would only help the TL react faster; the
  central FC server still has the source-of-truth status, fed from
  `github-poller.ts`.)
- A `log-tail` monitor that `tail -F`s a build / test log when the team is
  in the implementing phase. The dev agent gets test failures as
  notifications without polling.
- An `usage-warning` monitor inside the TL that watches a shared usage file
  written by FC's `usage-tracker.ts`. When usage tips into the red, the TL
  is notified immediately instead of on the next 15-minute poll.

These are session-local enhancements, not replacements. The Fastify server
remains the hub for cross-team aggregation and dashboard visibility.

### Additional monitor constraints (CC v2.1.142 docs)

The plugins-reference also notes constraints that are easy to overlook:

- Plugin monitors require CC v2.1.105 or later.
- Monitors "run only in interactive CLI sessions" and are "skipped on hosts
  where the Monitor tool is unavailable." FC spawns teams with
  `--input-format stream-json --output-format stream-json` (headless mode),
  so it is **not currently obvious** that plugin monitors would even start
  in FC-spawned sessions. This needs validation before any monitor work.
- "Disabling a plugin mid-session does not stop monitors that are already
  running. They stop when the session ends." Implications for FC: if a TL
  disables FC mid-session to switch profiles, its monitors keep running.
- The `experimental.monitors` field is explicitly experimental — the
  schema may change between CC releases. The top-level `monitors` key
  still works today but emits a `claude plugin validate` warning; a
  future CC release will require `experimental.*`.

Conclusion for question 3: **monitors do not replace
`POST /api/events`.** They are useful additions inside individual
sessions, but the Fastify server still has to exist to aggregate
across teams.

---

## Question 4: Migration story for existing projects

**Direct answer: A two-step migration — uninstall the script-based install,
install the plugin — covers the common case. Repos with customizations to
`.claude/guides/` or `.claude/settings.json` need a third step to merge
custom content forward.**

The current uninstall (`scripts/uninstall.sh`) does four things: remove
`.claude/hooks/fleet-commander/`, remove FC hook entries from
`.claude/settings.json`, remove `.claude/prompts/fleet-workflow.md`, and
remove `.claude/agents/fleet-*.md`. It does **not** touch `.gitignore` or
`.claude/guides/`. (`.claude/guides/` is intentionally preserved because
repo-local guides may have been authored by the project owner.)

### Recommended migration sequence

For a target repo where FC was installed via `scripts/install.sh`:

1. **Uninstall the script-based install.** Run `bash scripts/uninstall.sh
   /path/to/target` from FC's own root. This removes hooks, agents,
   workflow, and FC entries from `settings.json`. Repo-local guides in
   `.claude/guides/` are preserved.
2. **Add the marketplace** (one-time per machine):
   `/plugin marketplace add hubertciebiada/fleet-commander-plugin`.
3. **Install the plugin** in the target repo:
   `claude plugin install fleet-commander@fleet-commander-plugin --scope project`
   from inside the repo. `--scope project` writes to
   `.claude/settings.json` so every contributor who clones the repo gets
   the plugin enabled.
4. **Run the init skill** (one-time per repo) for residual setup:
   `/plugin:fleet-commander:init`. This skill performs the work that
   `install.sh` did and a plugin cannot: render any per-repo workflow
   files, and append the FC entries to `.gitignore`.
5. **Verify**: `claude plugin list` shows `fleet-commander` enabled at
   project scope. `claude plugin validate fleet-commander` returns clean.

### Compatibility matrix

| Repo state before migration | What changes | Risk |
|-----------------------------|--------------|------|
| Vanilla FC install, no customizations | All hook scripts move from `.claude/hooks/fleet-commander/` to the plugin cache. `.claude/settings.json` becomes shorter. | Low. |
| Custom guides in `.claude/guides/<custom>.md` | Repo-local guides keep working — CC merges plugin skills with repo-local skills, repo wins on name conflict. | Low. |
| Custom hooks in `.claude/settings.json` not from FC | Migration must not strip non-FC hook entries from `settings.json`. The script-based uninstall already handles this (filter by `command.includes('fleet-commander')`); the plugin uninstall is even cleaner because it only removes plugin-injected entries. | Low. |
| In-progress teams running against the old install | Should be drained before migration. A team's worktree references hook paths via `${CLAUDE_PROJECT_DIR}/.claude/hooks/...`; if those paths disappear mid-flight, hooks silently no-op (they `exit 0` on missing curl/file, by design). | Medium — drain teams first. |
| Repo has a `.claude/settings.local.json` overriding hooks | Plugin install respects `local` vs `project` scope. The user can install at `--scope local` to keep behavior contained. | Low. |

### Init skill contract

The init skill is the smallest piece of "do-once" work that has to happen
per repo. Its responsibilities:

- Append FC's eleven `.gitignore` entries (the list lives in
  `src/server/utils/fc-manifest.ts` as `getGitignoreEntries()`).
- If the user wants per-repo workflow customization, ask for
  `{{PROJECT_NAME}}`, `{{project_slug}}`, `{{BASE_BRANCH}}` and write
  them to a `.fleet-config` file the plugin reads at team-launch time.
  (Alternative: have FC's `team-manager.ts` compute these the same way
  `install.sh` does today — `basename`, `tr/sed` slug, `git symbolic-ref`
  — and inject them at spawn time. This is preferred because it requires
  no per-repo init at all.)

If the placeholder substitution is moved into `team-manager.ts`, the init
skill collapses to just the `.gitignore` step.

---

## Question 5: Trade-offs

**Direct answer: The plugin model wins on update mechanism, install
ergonomics, and uninstall hygiene. It loses on per-repo customization,
the cross-platform install of bundled npm dependencies, and the need to
keep an out-of-tree HTTP server running. Net: positive for users,
neutral-to-positive for FC maintainers.**

| Aspect | Plugin model | Today's `install.sh` model |
|--------|--------------|----------------------------|
| Install command | `/plugin install fleet-commander@...` (one line, no shell) | `bash scripts/install.sh /path/to/repo` or `pwsh scripts/install.ps1 /path/to/repo` |
| Update mechanism | Push to the plugin repo, CC users see the new version on `/plugin update`. Auto-update fires if configured. | User pulls the FC repo and re-runs `install.sh`. No notification of new versions. |
| Update granularity | Per-version, governed by `plugin.json` `version` field (or git commit SHA if unset). Users can pin. | Whatever is in `templates/` and `hooks/` at the time `install.sh` runs. No per-version pinning per project. |
| Uninstall | `/plugin uninstall fleet-commander`. CC owns the cleanup. | `bash scripts/uninstall.sh`. FC owns the cleanup (and has to maintain symmetry with install). |
| Discoverability | Plugin appears in `/plugin` UI and in marketplace browse. | None — users discover FC via README. |
| Per-repo customization | Limited. Plugin files are static; per-repo placeholders need runtime substitution or an init skill. | Strong. Install script does `sed` substitution at install time. |
| Windows path handling | CC's plugin loader handles path normalization. No `getGitBash` workaround. | FC has dedicated code in `src/server/utils/hook-installer.ts` to find Git Bash and convert backslashes. |
| Versioning | `version` field in `plugin.json` is the cache key. Hot-reload via `/reload-plugins`. | Version stamp is `sed`-injected into each file at install time; users can run `head -1 .claude/prompts/fleet-workflow.md` to see it. |
| CI testing | `claude plugin validate --strict` runs in CI; same check as `claude-plugins-community` review pipeline. | No equivalent — `install.sh` correctness is asserted via FC's own test suite. |
| `${CLAUDE_PLUGIN_ROOT}` / `${CLAUDE_PROJECT_DIR}` substitution | Native. Hook commands need no awareness of where the plugin is installed. | FC has to bake absolute paths into `.claude/settings.json` at install time. |
| Server still required? | Yes — Fastify on port 4680 is still the central event collector, SSE broker, GitHub poller, dashboard. | Yes — same. |
| Cross-platform (Linux, macOS, Windows) | Plugin cache lives in `~/.claude/plugins/cache/` everywhere. | `install.sh` requires bash; `install.ps1` is the Windows wrapper. Two scripts to keep in sync. |
| Dependency on git in plugin install path | The plugin source path must be a git repo if you want commit-SHA versioning. Marketplace itself can be any git host. | None. |
| Hook fire-and-forget guarantee | Preserved — plugin hooks are just shell commands invoked the same way. | Preserved. |

### Where the plugin model is strictly better

- **Update story.** `/plugin update` is one keystroke. Today's flow
  ("`git pull` the FC repo, re-run `install.sh` against every registered
  project") is friction.
- **Discoverability.** Submitting to `anthropics/claude-plugins-community`
  puts FC in front of every CC user. Today FC is invisible unless someone
  reads the README.
- **Uninstall hygiene.** CC's plugin cache is owned by CC. FC's uninstall
  script has to enumerate every file it ever wrote and remove it — and
  every new file added in a release is a potential uninstall regression.
- **Cross-platform.** The plugin loader is one code path; FC currently has
  one `install.sh` and one `install.ps1`, with subtle differences.

### Where the install script is strictly better

- **Per-repo substitution.** `sed -e "s|{{PROJECT_NAME}}|$PROJECT_NAME|g"`
  happens at install time. The plugin model has no equivalent, so the
  substitution has to move into runtime (FC server) or into an init skill.
- **`.gitignore` mutation.** A plugin cannot write to `.gitignore`. An
  install script can.
- **Single-source-of-truth.** Everything in FC's `templates/` and `hooks/`
  is exactly what lands on disk. Plugins introduce the plugin cache as a
  second layer of indirection (`~/.claude/plugins/cache/.../hooks/...`)
  which is fine for users but adds debugging surface for FC maintainers.

### Where they are equivalent

- The Fastify server and its dependencies (`better-sqlite3`, `fastify`,
  `execa`, etc.) still have to be installed somewhere. Plugins do not
  change this.
- The MCP server (`bin/fleet-commander-mcp.js`) still has to run as a
  child process of CC; plugins reference it the same way today's user-side
  `.mcp.json` does.

---

## Features that work as a plugin

These are clean wins — they can move into a plugin verbatim:

- **All twelve hook entries** in `hooks/settings.json.example` map to
  `hooks/hooks.json` with `${CLAUDE_PLUGIN_ROOT}` substitution. Every CC
  hook event FC subscribes to (SessionStart, SessionEnd, Stop,
  StopFailure, SubagentStart, SubagentStop, Notification, PreCompact,
  PostToolUse, TeammateIdle, TaskCreated, PostToolUseFailure) is a
  first-class plugin feature.
- **All 14 hook scripts** in `hooks/*.sh` ship in the plugin's `hooks/`
  directory and are invoked through `${CLAUDE_PLUGIN_ROOT}`. The version
  stamping done in `install.sh` (lines 100-104) becomes redundant — the
  plugin's `version` is the version stamp.
- **The MCP server** at `bin/fleet-commander-mcp.js` is registered via
  `mcpServers` in the manifest. CC starts it on plugin enable. No user
  `.mcp.json` edits required.
- **Agent templates**, with the caveat that placeholders are resolved at
  team-launch time by `team-manager.ts` rather than at install time by
  `sed`. The plugin ships the template files; the substitution moves
  upstream.
- **Guidebooks**, either as one skill per guide (`skills/csharp-conventions/SKILL.md`)
  or bundled into one skill that references all of them. The "repo-local
  overrides plugin" semantics work without additional code because CC
  merges plugin skills and repo-local skills, with repo-local winning on
  the same name.
- **Bin directory** — if FC wants to expose `fleet-commander-mcp` as a
  bare command in the Bash tool, dropping the script in the plugin's
  `bin/` directory adds it to `PATH` automatically while the plugin is
  enabled.
- **User configuration** — `FLEET_SERVER_URL` and the dozens of FC env
  vars in CLAUDE.md can be exposed via `userConfig` so the user is
  prompted on first enable instead of having to read CLAUDE.md.
- **CI validation** — `claude plugin validate --strict` runs in the
  plugin repo's CI, catching schema regressions before publish.
- **Discoverability** — submitting the plugin to
  `anthropics/claude-plugins-community` puts FC in front of CC users.

---

## Features that do NOT work as a plugin

These are the places where the plugin model breaks down and a runtime
workaround is required:

- **Per-repo placeholder substitution** (`{{PROJECT_NAME}}`,
  `{{project_slug}}`, `{{BASE_BRANCH}}` in `templates/workflow.md` and
  `templates/agents/*.md`). Plugins ship static files; CC does not
  substitute `{{...}}` placeholders. Resolution: move substitution into
  `team-manager.ts` so values are computed at team-launch time. The
  values already exist in the DB (`projects.path`, `projects.default_branch`)
  and in `cc-spawn.ts` `buildEnv()`.
- **`.gitignore` mutation.** Plugins are read-only with respect to the
  target repo. The eleven `getGitignoreEntries()` paths must be added
  somehow. Cleanest: an init skill that appends them on first run.
  Acceptable alternative: document the entries in the plugin README and
  accept that `git status` will show FC-managed files until the user
  adds them.
- **The Fastify HTTP server.** Plugins are CC-side; the FC server is a
  separate Node process listening on port 4680. The plugin cannot start
  the server, and `installHooks` / `installProject` in FC's own UI still
  has to know whether the user has FC running. The plugin install does
  not change this — the user still runs `npx fleet-commander-ai` or
  `fleet-commander.bat` separately.
- **The worktree spawn machinery.** `team-manager.ts` calls
  `child_process.spawn` against the CC CLI with carefully constructed
  environment (`buildEnv` in `cc-spawn.ts`). This is FC server-side
  code; the plugin does not touch it.
- **Runtime context files** — `.fleet-issue-context.md`,
  `.fleet-pm-message`, `changes.md`, `plan.md`, `review.md`. These are
  written into the worktree by FC server code, not by a plugin. They
  remain entirely server-side.
- **Project install state tracking.** The dashboard's Projects view
  computes install status by scanning for FC-managed files in the
  target repo (`src/server/routes/projects.ts`). With a plugin install,
  the files live in `~/.claude/plugins/cache/...`, not in the target
  repo. The install-status check needs to change to "is the plugin
  enabled in this repo's `.claude/settings.json`?" — readable via the
  marketplace ID in `enabledPlugins`.
- **Hook scripts running in headless CC sessions.** FC spawns CC with
  `--output-format stream-json` (headless / programmatic mode). Plugin
  hooks fire in this mode because hooks are universal. Plugin
  **monitors**, however, are documented to run "only in interactive
  CLI sessions" — they will not arm in FC-spawned headless sessions.
  This is the single biggest gotcha for any monitors-based plan.
- **Plugin agent restrictions.** Plugin-shipped agents cannot define
  their own `hooks`, `mcpServers`, or `permissionMode` (security
  restriction in plugins-reference). FC's agents do not currently do
  any of these, so this is not blocking — but it forecloses future
  designs where, say, a planner agent wants its own MCP server.
- **The dashboard.** The React app at `http://localhost:4680/` is
  static assets served by the Fastify server. Plugins do not host web
  UIs. Net: no change here — the dashboard stays where it is.
- **Database (`fleet.db`).** Lives at the platform user-data dir
  (`FLEET_DB_PATH`). Plugins do not interact with this. Net: no change.
- **GitHub poller, SSE broker, stuck detector, usage tracker.** All
  Fastify-side services. Plugins do not change them. Net: no change.

---

## Recommendation

A **phased adoption** rather than a binary "rip out `install.sh` and ship a
plugin" replacement. The phases are designed so each one is shippable on
its own and can be paused indefinitely if anything breaks.

### Phase 1 — Ship a plugin variant alongside `install.sh`

- Create a sibling repo, `fleet-commander-plugin`, with `.claude-plugin/marketplace.json`
  and `plugins/fleet-commander/` containing `.claude-plugin/plugin.json`.
- Bundle FC's current `hooks/` and `templates/` verbatim. Reference everything
  through `${CLAUDE_PLUGIN_ROOT}`.
- For the placeholder substitution gap, keep the existing
  `team-manager.ts` `sed`-equivalent step working at team-launch time and
  ship the templates **with placeholders still present**. The plugin
  agent files are read as-is and substituted at spawn time.
- Document both install paths in FC's README. Mark the plugin path as
  "experimental — preferred for new installs."
- Run `claude plugin validate --strict` in the plugin repo's CI.
- Do **not** remove `scripts/install.sh` or modify its behavior. The two
  paths coexist.

Exit criteria for Phase 1: at least three projects have run successfully
on the plugin install for at least one full week, with no regressions
observed in dashboard event ingestion or team launch.

### Phase 2 — Add a `fleet-commander init` shim for residual setup

- Implement either (a) a `/plugin:fleet-commander:init` skill that appends
  to `.gitignore` and prompts the user for any custom workflow values, or
  (b) a tiny `fleet-commander init` CLI subcommand in
  `bin/fleet-commander.js` that does the same thing.
- The skill / subcommand is idempotent — running it twice is a no-op.
- Update FC's "Add Project" dashboard UI to detect a plugin-style install
  and call the init skill / CLI on the user's behalf.

Exit criteria for Phase 2: `bash scripts/install.sh /path/to/repo` and
`claude /plugin install fleet-commander@... && fleet-commander init` produce
byte-identical results in `.gitignore` and runtime behavior.

### Phase 3 — Deprecate `scripts/install.sh` (no committed timeline)

- After Phase 2 has been stable for at least one minor FC release with no
  reported regressions, mark `scripts/install.sh` and `scripts/install.ps1`
  as deprecated in the README. Keep them functional.
- One major release later — if and only if the user community has migrated
  — remove the scripts entirely.

Explicitly **not** part of this recommendation:

- **Do not** propose replacing the Fastify HTTP server with plugin
  monitors. The architectures do not match. The server is the central
  aggregator; monitors are session-local notification streams.
- **Do not** create a `plugin.json`, `monitors.json`, `.claude-plugin/`
  directory, or any other scaffolding in the FC repo itself as part of
  this research issue. The plugin lives in a separate repo.
- **Do not** remove `scripts/install.sh` before Phase 2 is complete.
  Existing FC users depend on it.

### Why phased and not binary

- The placeholder-substitution gap is real and forecloses a clean rip-out.
- The CC v2.1.143+ `displayName` field and the `experimental.monitors`
  schema are both still moving. Pinning FC's distribution to a moving
  target is risky. Phased adoption lets FC track CC releases without a
  big-bang migration.
- The cost of running two install paths in parallel is small. The cost of
  shipping a broken plugin to the community marketplace is large.

---

## Open questions and follow-up issues

These are the concrete next steps once this analysis is approved. Each
should become its own GitHub issue.

1. **Decide repo layout for `fleet-commander-plugin`.** Sibling repo with
   `marketplace.json` and one plugin? Or a single repo that doubles as
   marketplace and plugin (allowed — `marketplace.json` and `plugin.json`
   can coexist)? Trade-off: simpler vs. flexibility to add more plugins
   later (for example a `fleet-commander-claude-flow` plugin).
2. **Author the `fleet-commander init` spec.** What exactly does it do?
   Should it be a skill, a CLI subcommand, or both? Where does it write
   the per-repo config — `.fleet-config`, `.claude/settings.local.json`,
   or something else? How does it interact with FC's "Install" button in
   the Projects view?
3. **Audit placeholder-to-env-var migration via `cc-spawn.ts buildEnv()`.**
   The cleanest fix for the placeholder gap is moving substitution into
   the FC server. List every `{{PLACEHOLDER}}` currently in
   `templates/workflow.md` and `templates/agents/*.md`. Confirm each one
   can be expressed as an environment variable that `buildEnv()` already
   sets (or could trivially set), or that `team-manager.ts` can substitute
   into the workflow file when it writes the per-team `.claude/prompts/`
   directory.
4. **Validate plugin monitors work in headless CC sessions.** FC spawns
   teams with `--output-format stream-json`. The plugins-reference
   states monitors "run only in interactive CLI sessions." Before any
   monitor-based work, run an empirical test: ship a one-line monitor
   in a `--plugin-dir` plugin, spawn CC headlessly, and confirm whether
   the monitor starts. If it does not, monitors are unavailable to FC
   for all the per-team use cases described above and only useful to
   the user's own interactive CC sessions.
5. **Confirm `enabledPlugins` value FC's install-status check should
   look for.** `hooks/settings.json.example` already sets
   `enabledPlugins: { "security-guidance@claude-plugins-official": true }`
   for the security-guidance plugin. The plugin install would add
   `enabledPlugins: { "fleet-commander@hubertciebiada-plugins": true }`.
   `projects.ts` `checkInstallStatus()` would parse this. Confirm the
   exact key format with `claude plugin install --scope project` against
   a test repo.
6. **Decide on `displayName` adoption.** `displayName` requires CC
   v2.1.143+. FC's plugin would be one of the first to set it. Worth
   doing for the `/plugin` picker UX, but means FC's plugin requires a
   minimum CC version higher than 2.1.105 (the monitors floor).

---

*This analysis is based on Claude Code documentation as of v2.1.142 (May
2026 revision at `code.claude.com/docs/en/`). Specific feature versions
cited: monitors v2.1.105, `claude plugin prune` v2.1.121, `--plugin-dir
.zip` v2.1.128, ignored-default-folder warning v2.1.140, single-skill
auto-load and `lspServers` v2.1.142, `displayName` v2.1.143. Bump these
versions when the analysis is revised.*

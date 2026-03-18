# Guidebook System Design

## Problem

Fleet Commander currently ships 6 specialized dev agent templates (C#, F#, TypeScript, Python, DevOps, generic), each with hardcoded domain knowledge baked into their prompt. This creates several problems:

1. **Prompt bloat** -- every specialist carries ~80 lines of domain knowledge whether the task needs it or not.
2. **Rigid mapping** -- the Coordinator must pick the "right" specialist. Mixed-language tasks require sequential handoffs between agents.
3. **No repo customization** -- a C# project using NHibernate instead of EF Core gets the same EF-centric advice.
4. **Scaling** -- adding a new language or framework means creating an entire new agent template.

## Solution: One Generalist + Guidebooks

Replace 6 specialist devs with one generalist dev agent that dynamically reads guidebook `.md` files based on the Analyst's recommendation. The Analyst already explores the codebase and classifies the work type -- it simply adds a `GUIDES:` line to its brief.

```
ISSUE: #42 Add NHibernate audit trail
TYPE: C#/.NET
GUIDES: csharp-conventions, nhibernate-patterns
FILES: ...
```

The Coordinator passes the guide list to the dev in the task. The dev reads the specified guidebooks before implementing.

---

## 1. Where Guidebooks Live

**Recommendation: Option C -- FC provides defaults, repo can override.**

```
fleet-commander/
  templates/
    guides/                    # FC ships these defaults
      csharp-conventions.md
      fsharp-conventions.md
      typescript-conventions.md
      python-conventions.md
      devops-conventions.md
      sql-database.md
      testing-strategies.md

target-repo/
  .claude/
    guides/                    # Repo-specific overrides and additions
      csharp-conventions.md    # Overrides FC default (same filename wins)
      nhibernate-patterns.md   # Repo-specific addition
```

### Resolution order

When the dev reads a guidebook named `foo`:

1. Check `.claude/guides/foo.md` in the target repo -- if found, use it.
2. Fall back to `templates/guides/foo.md` in the Fleet Commander install.

This is the same pattern as CLAUDE.md itself: every project has one, but the content is project-specific.

### Rationale

- **Not just in the target repo** -- new projects get useful defaults immediately without someone writing guides from scratch.
- **Not just in FC** -- repos need project-specific conventions (e.g., "we use NHibernate, not EF" or "our React components use MobX, not Redux").
- **Override by filename** -- simple, no merge logic. If the repo has `csharp-conventions.md`, the FC default is ignored entirely. This avoids conflicting advice.

### Installation

The `install.sh` script gains a new step that copies `templates/guides/*.md` into `.claude/guides/` in the target repo, but only if the file does not already exist (never overwrites repo customizations):

```bash
# ── 5. Install default guidebooks ──────────────────────────────
GUIDES_SRC="$FC_ROOT/templates/guides"
GUIDES_DIR="$TARGET/.claude/guides"

if [ -d "$GUIDES_SRC" ]; then
  mkdir -p "$GUIDES_DIR"
  GUIDE_COUNT=0
  for GUIDE_FILE in "$GUIDES_SRC"/*.md; do
    [ -f "$GUIDE_FILE" ] || continue
    GUIDE_NAME="$(basename "$GUIDE_FILE")"
    # Never overwrite repo-specific guides
    if [ ! -f "$GUIDES_DIR/$GUIDE_NAME" ]; then
      cp "$GUIDE_FILE" "$GUIDES_DIR/$GUIDE_NAME"
      GUIDE_COUNT=$((GUIDE_COUNT + 1))
    fi
  done
  echo "  Installed $GUIDE_COUNT new guidebooks to $GUIDES_DIR"
else
  echo "  No guidebook templates found (skipped)"
fi
```

---

## 2. Guidebook Format

Every guidebook follows this standard structure:

```markdown
# {Language/Topic} Conventions

> Applies to: {file patterns, e.g., *.cs, *.fsproj, Dockerfile}
> Last updated: {date}

## Architecture

{How the codebase is structured. Layers, namespaces, module organization.}

## Naming Conventions

{Naming rules for files, classes, functions, variables, database entities.}

## Patterns to Follow

{Approved patterns with brief code examples. DDD, CQRS, Railway, etc.}

## Anti-Patterns to Avoid

{Things that look tempting but are wrong in this codebase. Include WHY.}

## Dependencies & Imports

{Package management rules. What's approved, what's banned. Import ordering.}

## Testing

{Test framework, test file naming, fixture patterns, minimum expectations.}

## Build & Run

{How to build, test, and validate changes locally before committing.}

## Common Pitfalls

{Things that have bitten developers before. Compilation order, migration gotchas, etc.}
```

### Format rules

- **Keep it under 200 lines.** Guidebooks must fit in a single context-efficient read. If a topic needs more, split into two guides.
- **Use code examples sparingly.** Show the pattern once, don't repeat variations.
- **Be prescriptive, not descriptive.** "Use `decimal` for money" not "F# supports several numeric types."
- **No workflow instructions.** Guidebooks cover *what* and *how* for the code, not the FC team workflow (that stays in the agent template).

---

## 3. How the Analyst Discovers Guidebooks

**Recommendation: Glob-based discovery + CLAUDE.md hints.**

The Analyst's brief workflow gains one additional step between "Read CLAUDE.md" and "Explore the codebase":

### Step 2.5: Discover Available Guides

```
### 2.5. Discover Available Guides

Scan for guidebooks:
1. Glob `.claude/guides/*.md` — list all available guide files.
2. Read CLAUDE.md — look for a `## Guides` section that may describe or prioritize guides.
3. From the list of available guides and your understanding of the issue's tech stack,
   select 1-3 guides that are most relevant to the implementation work.
4. Include them in the brief as: `GUIDES: {name1}, {name2}`
   (filenames without .md extension, comma-separated)

If no guides are found or none are relevant, omit the GUIDES line.
```

### Why not a manifest file?

A `guides/index.md` manifest adds a maintenance burden (someone must update it when adding a guide) and provides no benefit over globbing. The filenames themselves are descriptive enough: `csharp-conventions.md`, `nhibernate-patterns.md`. The Analyst can read the first few lines of any guide to determine relevance.

### Why allow CLAUDE.md hints?

Some repos may want to say "always include the `security-requirements` guide for any change" or "the `legacy-api` guide is only relevant for files in `src/api/v1/`". A `## Guides` section in CLAUDE.md lets the repo owner express this without modifying the FC agent template.

Example CLAUDE.md section:

```markdown
## Guides

Available in `.claude/guides/`:

| Guide | When to use |
|-------|-------------|
| csharp-conventions | Any C# change |
| nhibernate-patterns | Changes touching `src/Infrastructure/Persistence/` |
| security-requirements | Any change to authentication or authorization |
| legacy-api | Changes in `src/Api/V1/` only |
```

---

## 4. Default Guidebooks FC Should Ship

Based on extracting domain knowledge from the 6 specialist agent templates:

| Guidebook | Extracted from | Covers |
|-----------|---------------|--------|
| `csharp-conventions.md` | fleet-dev-csharp | DDD, EF Core, DI, ASP.NET, async patterns, NuGet |
| `fsharp-conventions.md` | fleet-dev-fsharp | Compilation order, DUs, Railway, CEs, decimal for money, .fsproj |
| `typescript-conventions.md` | fleet-dev-typescript | React hooks, strict types, no `any`, package managers, Vite/tsc |
| `python-conventions.md` | fleet-dev-python | PEP 8, type hints, venv, Django/FastAPI, pytest, pathlib |
| `devops-conventions.md` | fleet-dev-devops | GitHub Actions, Docker, cross-platform scripts, secrets, YAML |
| `sql-database.md` | (new) | Migration patterns, indexing, query optimization, ORM-agnostic |
| `testing-strategies.md` | (new) | Unit vs integration vs E2E, mocking strategies, test naming, coverage |
| `api-design.md` | (new) | REST conventions, error responses, pagination, versioning |

The first 5 are direct extractions from existing specialist knowledge. The last 3 are cross-cutting concerns that no single specialist owned but that come up frequently.

### Additional repo-specific guides users might create

These are NOT shipped by FC but are examples of what teams would add to `.claude/guides/` in their own repos:

- `nhibernate-patterns.md` -- for projects using NHibernate instead of EF Core
- `mobx-state.md` -- for React projects using MobX
- `grpc-services.md` -- for projects with gRPC instead of REST
- `domain-glossary.md` -- domain-specific terminology and business rules
- `security-requirements.md` -- project-specific security constraints

---

## 5. Example Guidebook: F# Conventions

This is the most interesting extraction because F# has genuinely dangerous pitfalls (compilation order) that a generalist dev would not know about.

See the full guidebook at: `templates/guides/fsharp-conventions.md`

---

## 6. How CLAUDE.md References Guidebooks

CLAUDE.md should have an **optional** `## Guides` section. It is not required -- the Analyst can discover guides by globbing -- but it provides context about when each guide applies.

### Recommended format

```markdown
## Guides

Development guidebooks are in `.claude/guides/`. The Analyst selects relevant
guides based on the issue's tech stack and includes them in the brief.

| Guide | When to use |
|-------|-------------|
| csharp-conventions | Any C# / .NET change |
| fsharp-conventions | Any F# change — READ THIS before touching .fsproj files |
| typescript-conventions | Any TypeScript/JavaScript change |
| python-conventions | Any Python change |
| devops-conventions | CI/CD, Docker, infrastructure changes |
| sql-database | Database schema or migration changes |
| testing-strategies | When adding or restructuring tests |
```

### Why a table, not just a list?

The "When to use" column helps the Analyst make better selections. Without it, the Analyst must open each guide to determine relevance. With it, the Analyst can immediately narrow to 1-3 guides based on the issue type.

---

## 7. Changes to Agent Templates

### fleet-dev-generic.md (becomes the only dev agent)

The generic dev template gains a guidebook-reading step in its workflow:

```markdown
## Workflow

1. **Receive task** from Coordinator with issue details, target branch name, and **guide list**
2. **Read CLAUDE.md** in the project root for project-specific conventions
3. **Read guidebooks** — for each guide in the task's guide list:
   - Read `.claude/guides/{name}.md`
   - Internalize the conventions before writing any code
4. **Explore the codebase** — understand the relevant files, patterns, and test structure
5. **Create branch** from `{{BASE_BRANCH}}` ...
```

The `## Domain Knowledge` section is removed entirely -- that knowledge now lives in the guidebooks.

### fleet-analyst.md

Add step 2.5 (Discover Available Guides) and update the brief format:

```markdown
## Brief Format

ISSUE: #{N} {title}
TYPE: {language/framework} | mixed ({specify each})
GUIDES: {guide1}, {guide2} (or "none")
FILES:
  - {path} — {what changes and why}
SCOPE: {what needs to change and why}
RISKS: {specific risks}
BLOCKED: no | yes → {reason}
```

### fleet-coordinator.md

Update the TYPE -> Developer Mapping table to use a single generalist:

```markdown
### TYPE -> Developer Mapping

All implementation work is assigned to `fleet-dev-generic`. The Analyst's
GUIDES line tells the dev which guidebooks to read for domain-specific
conventions.

When creating the task for the dev, always include:
- The brief's SCOPE and FILES
- The GUIDES list (the dev reads these before implementing)
- The target branch name
```

### Templates to remove

The following specialist templates become unnecessary and should be removed:
- `fleet-dev-csharp.md`
- `fleet-dev-fsharp.md`
- `fleet-dev-typescript.md`
- `fleet-dev-python.md`
- `fleet-dev-devops.md`

Their domain knowledge is preserved in the corresponding guidebooks.

### workflow.md

Update the Team Structure table:

```markdown
## Team Structure

| Agent | subagent_type | name | Role | Spawn |
|-------|---------------|------|------|-------|
| **Coordinator** | `fleet-coordinator` | `coordinator` | Manages the cycle | CORE |
| Analyst | `fleet-analyst` | `analyst` | Analyzes issue + codebase | CORE |
| Reviewer | `fleet-reviewer` | `reviewer` | Code review + acceptance | CORE |
| Developer | `fleet-dev-generic` | `dev` | Implementation (reads guidebooks) | On demand |
```

---

## 8. Install Status Tracking

The `checkInstallStatus()` function in `projects.ts` should be extended to track guidebook installation:

```typescript
// Guidebooks expected in .claude/guides/
const guidesDir = path.join(repoPath, '.claude', 'guides');
const guideFiles: InstallFileStatus[] = fs.existsSync(guidesDir)
  ? fs.readdirSync(guidesDir)
      .filter(f => f.endsWith('.md'))
      .map(name => ({ name, exists: true }))
  : [];

return {
  hooks: { ... },
  prompt: { ... },
  agents: { ... },
  settings: settingsFile,
  guides: {
    installed: guideFiles.length > 0,
    count: guideFiles.length,
    files: guideFiles,
  },
};
```

---

## Summary of Changes

| Component | Change |
|-----------|--------|
| `templates/guides/*.md` | New directory with 5-8 default guidebooks |
| `templates/agents/fleet-dev-generic.md` | Add guidebook-reading step to workflow |
| `templates/agents/fleet-analyst.md` | Add guide discovery step + GUIDES line in brief |
| `templates/agents/fleet-coordinator.md` | Simplify to single dev type + pass GUIDES |
| `templates/workflow.md` | Simplify team structure table |
| `scripts/install.sh` | Add step 5: copy default guides (no-overwrite) |
| `src/server/routes/projects.ts` | Add guides to install status check |
| `templates/agents/fleet-dev-{csharp,fsharp,typescript,python,devops}.md` | Remove (replaced by guidebooks) |

### Token budget impact

Before: A C# specialist prompt is ~800 tokens of domain knowledge loaded unconditionally.
After: The generic dev prompt is ~400 tokens. A guidebook is ~600-1000 tokens loaded only when needed. Net effect: tasks that need one guide are roughly equivalent; tasks that need zero guides save ~400 tokens; the Analyst's guide discovery adds ~100 tokens to its prompt.

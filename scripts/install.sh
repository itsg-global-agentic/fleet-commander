#!/bin/bash
# Fleet Commander Installer
# Installs hook scripts, merges settings.json, deploys workflow prompt,
# and copies agent templates into a target repo's .claude directory.
#
# Usage: ./scripts/install.sh [/path/to/target/repo]
#   If no path given, auto-detects the git repo root from current directory.

# Ensure standard Unix tools are on PATH — when Git Bash's usr/bin/bash.exe
# is invoked directly (not via git-bash.exe), /usr/bin may be missing.
export PATH="/usr/bin:/bin:$PATH"

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
FC_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# ── Read FC version from package.json ────────────────────────────
FC_VERSION="unknown"
if [ -f "$FC_ROOT/package.json" ]; then
  FC_VERSION="$(node -e "try{console.log(JSON.parse(require('fs').readFileSync(process.argv[1],'utf-8')).version||'unknown')}catch{console.log('unknown')}" "$FC_ROOT/package.json")"
fi

# ── Ensure prompts directory and default prompt exist ──────────────
mkdir -p "$FC_ROOT/prompts"
if [ ! -f "$FC_ROOT/prompts/default-prompt.md" ]; then
  cat > "$FC_ROOT/prompts/default-prompt.md" << 'PROMPT_EOF'
Read the ENTIRE file `.claude/prompts/fleet-workflow.md` before taking any actions.

You are the Team Lead (TL). Your job:
1. Read the workflow to understand the Diamond team structure (Analyst → Dev → Reviewer)
2. There is NO coordinator — you orchestrate all 3 agents directly
3. Phase 1: Spawn `fleet-planner` to analyze the issue and produce a plan
4. Phase 2: Spawn the appropriate `fleet-dev-*` specialist based on the plan's TYPE field
5. Phase 3: When dev reports "ready for review", spawn `fleet-reviewer`
6. Let dev and reviewer communicate peer-to-peer during review — do NOT relay messages
7. After APPROVE: rebase, create PR, set auto-merge
8. Respond to FC messages (ci_green, ci_red, pr_merged, nudges) promptly
9. On pr_merged: close issue, shut down agents, finish

Issue: #{{ISSUE_NUMBER}}
PROMPT_EOF
  echo "  Created default prompt: $FC_ROOT/prompts/default-prompt.md"
fi

# ── Validate required template files ───────────────────────────────
if [ ! -f "$FC_ROOT/templates/workflow.md" ]; then
  echo "ERROR: templates/workflow.md not found"
  exit 1
fi
if [ ! -f "$FC_ROOT/hooks/settings.json.example" ]; then
  echo "ERROR: hooks/settings.json.example not found"
  exit 1
fi

# Target repo: argument or auto-detect
TARGET="${1:-$(git rev-parse --show-toplevel 2>/dev/null || echo "")}"
if [ -z "$TARGET" ]; then
  echo "Error: No target repo specified and not in a git repository"
  echo "Usage: $0 /path/to/target/repo"
  exit 1
fi

# Verify TARGET exists before attempting to cd into it
if [ ! -d "$TARGET" ]; then
  echo "Error: Target directory does not exist: $TARGET"
  exit 1
fi

# Normalise path (resolve symlinks, remove trailing slash)
TARGET="$(cd "$TARGET" && pwd)"

echo "Installing Fleet Commander into: $TARGET"
echo ""

# ── 1. Copy hook scripts ─────────────────────────────────────────
HOOK_DIR="$TARGET/.claude/hooks/fleet-commander"
mkdir -p "$HOOK_DIR"

# Copy all .sh files from the hooks directory, updating version stamps.
# Source files already carry a stamp on line 2; replace it with the install-time version.
for SH_FILE in "$FC_ROOT/hooks/"*.sh; do
  [ -f "$SH_FILE" ] || continue
  SH_NAME="$(basename "$SH_FILE")"
  sed "2s|^# fleet-commander v.*|# fleet-commander v${FC_VERSION}|" "$SH_FILE" > "$HOOK_DIR/$SH_NAME"
done
# Ensure LF line endings — bash on Windows chokes on CRLF shebangs
sed -i 's/\r$//' "$HOOK_DIR/"*.sh
chmod +x "$HOOK_DIR/"*.sh

echo "  Copied hook scripts to $HOOK_DIR (v${FC_VERSION})"

# ── 2. Merge into .claude/settings.json ──────────────────────────
SETTINGS="$TARGET/.claude/settings.json"
EXAMPLE="$FC_ROOT/hooks/settings.json.example"

if [ -f "$SETTINGS" ]; then
  # Merge Fleet Commander hook entries into existing settings,
  # preserving all existing hooks. Uses Node for reliable JSON handling.
  node -e "
    const fs = require('fs');
    const existing = JSON.parse(fs.readFileSync(process.argv[1], 'utf-8'));
    const example = JSON.parse(fs.readFileSync(process.argv[2], 'utf-8'));

    if (!existing.hooks) existing.hooks = {};

    for (const [hookType, entries] of Object.entries(example.hooks || {})) {
      for (const entry of entries) {
        // Only add fleet-commander entries; skip others like pr-watcher
        const commands = (entry.hooks || []).map(h => h.command || '');
        const isFC = commands.some(c => c.includes('fleet-commander'));
        if (!isFC) continue;

        // Ensure the array exists for this hook type
        if (!existing.hooks[hookType]) existing.hooks[hookType] = [];

        // Check if this exact entry already exists (idempotent)
        const entryStr = JSON.stringify(entry);
        const alreadyExists = existing.hooks[hookType].some(
          e => JSON.stringify(e) === entryStr
        );
        if (!alreadyExists) {
          existing.hooks[hookType].push(entry);
        }
      }
    }

    existing._fleetCommanderVersion = process.argv[3];
    fs.writeFileSync(process.argv[1], JSON.stringify(existing, null, 2) + '\n');
  " "$SETTINGS" "$EXAMPLE" "$FC_VERSION"
  echo "  Merged hook entries into existing settings.json (v${FC_VERSION})"
else
  mkdir -p "$TARGET/.claude"
  # Copy template and inject version stamp
  node -e "
    const fs = require('fs');
    const data = JSON.parse(fs.readFileSync(process.argv[1], 'utf-8'));
    data._fleetCommanderVersion = process.argv[2];
    fs.writeFileSync(process.argv[3], JSON.stringify(data, null, 2) + '\n');
  " "$EXAMPLE" "$FC_VERSION" "$SETTINGS"
  echo "  Created settings.json from template (v${FC_VERSION})"
fi

# ── 3. Install workflow template and command ─────────────────────
PROMPTS_DIR="$TARGET/.claude/prompts"
mkdir -p "$PROMPTS_DIR"

# Derive project name from the target directory basename
PROJECT_NAME="$(basename "$TARGET")"
# Lowercase slug (replace spaces/special chars with hyphens)
project_slug="$(echo "$PROJECT_NAME" | tr '[:upper:]' '[:lower:]' | sed 's/[^a-z0-9]/-/g' | sed 's/--*/-/g' | sed 's/^-//;s/-$//')"

# Detect default branch
BASE_BRANCH="$(git -C "$TARGET" symbolic-ref refs/remotes/origin/HEAD 2>/dev/null | sed 's|refs/remotes/origin/||')" || true
if [ -z "$BASE_BRANCH" ]; then
  BASE_BRANCH="main"
fi

# Copy workflow template with placeholder replacement + version stamp.
# Source file already carries a stamp on line 1; strip it before replacement
# and prepend the install-time version stamp.
WORKFLOW_TARGET="$PROMPTS_DIR/fleet-workflow.md"
VERSION_STAMP="<!-- fleet-commander v${FC_VERSION} -->"
TEMPLATE_CONTENT=$(sed -e '1{/^<!-- fleet-commander v/d}' \
    -e "s|{{PROJECT_NAME}}|$PROJECT_NAME|g" \
    -e "s|{{project_slug}}|$project_slug|g" \
    -e "s|{{BASE_BRANCH}}|$BASE_BRANCH|g" \
    "$FC_ROOT/templates/workflow.md")
NEW_WORKFLOW_CONTENT="${VERSION_STAMP}
${TEMPLATE_CONTENT}"

if [ -f "$WORKFLOW_TARGET" ]; then
  # Strip any existing version stamp line before comparing content
  EXISTING_WORKFLOW_CONTENT=$(cat "$WORKFLOW_TARGET")
  EXISTING_STRIPPED=$(echo "$EXISTING_WORKFLOW_CONTENT" | sed '1{/^<!-- fleet-commander v/d}')
  NEW_STRIPPED="$TEMPLATE_CONTENT"
  if [ "$NEW_STRIPPED" = "$EXISTING_STRIPPED" ]; then
    # Content unchanged — just update the version stamp if needed
    if [ "$(head -1 "$WORKFLOW_TARGET")" != "$VERSION_STAMP" ]; then
      printf '%s\n' "$NEW_WORKFLOW_CONTENT" > "$WORKFLOW_TARGET"
      echo "  Updated version stamp in workflow template"
    else
      echo "  Workflow template already up to date"
    fi
  else
    BACKUP="$WORKFLOW_TARGET.backup.$(date +%Y%m%d_%H%M%S)"
    cp "$WORKFLOW_TARGET" "$BACKUP"
    echo "  Backed up existing workflow to $(basename "$BACKUP")"
    printf '%s\n' "$NEW_WORKFLOW_CONTENT" > "$WORKFLOW_TARGET"
    echo "  Installed workflow template to $WORKFLOW_TARGET"
  fi
else
  printf '%s\n' "$NEW_WORKFLOW_CONTENT" > "$WORKFLOW_TARGET"
  echo "  Installed workflow template to $WORKFLOW_TARGET"
fi
echo "    PROJECT_NAME=$PROJECT_NAME  project_slug=$project_slug  BASE_BRANCH=$BASE_BRANCH"

# ── 4. Install agent templates ───────────────────────────────
AGENTS_SRC="$FC_ROOT/templates/agents"
AGENTS_DIR="$TARGET/.claude/agents"

if [ -d "$AGENTS_SRC" ]; then
  mkdir -p "$AGENTS_DIR"
  AGENT_COUNT=0
  for AGENT_FILE in "$AGENTS_SRC"/*.md; do
    [ -f "$AGENT_FILE" ] || continue
    AGENT_NAME="$(basename "$AGENT_FILE")"
    # Source files carry _fleetCommanderVersion inside YAML frontmatter; replace it with install-time version
    sed -e "s|^_fleetCommanderVersion:.*|_fleetCommanderVersion: \"${FC_VERSION}\"|" \
        -e "s|{{PROJECT_NAME}}|$PROJECT_NAME|g" \
        -e "s|{{project_slug}}|$project_slug|g" \
        -e "s|{{BASE_BRANCH}}|$BASE_BRANCH|g" \
        "$AGENT_FILE" > "$AGENTS_DIR/$AGENT_NAME"
    AGENT_COUNT=$((AGENT_COUNT + 1))
  done
  echo "  Installed $AGENT_COUNT agent templates to $AGENTS_DIR (v${FC_VERSION})"
else
  echo "  No agent templates found in $AGENTS_SRC (skipped)"
fi

# ── 5. Install guidebooks ────────────────────────────────────────
GUIDES_SRC="$FC_ROOT/templates/guides"
GUIDES_DIR="$TARGET/.claude/guides"

if [ -d "$GUIDES_SRC" ]; then
  mkdir -p "$GUIDES_DIR"
  GUIDE_COUNT=0
  for GUIDE_FILE in "$GUIDES_SRC"/*.md; do
    [ -f "$GUIDE_FILE" ] || continue
    GUIDE_NAME="$(basename "$GUIDE_FILE")"
    if [ ! -f "$GUIDES_DIR/$GUIDE_NAME" ]; then
      # Source files already carry a stamp on line 1; replace it with install-time version
      sed "1s|^<!-- fleet-commander v.* -->|<!-- fleet-commander v${FC_VERSION} -->|" \
          "$GUIDE_FILE" > "$GUIDES_DIR/$GUIDE_NAME"
      GUIDE_COUNT=$((GUIDE_COUNT + 1))
    fi
  done
  echo "  Installed $GUIDE_COUNT new guidebooks to $GUIDES_DIR (existing preserved)"
else
  echo "  No guidebooks found in $GUIDES_SRC (skipped)"
fi

# ── 6. Clean up retired agent templates ──────────────────────────
OLD_AGENTS=(
  "fleet-coordinator.md"
  "fleet-analyst.md"
  "fleet-dev-generic.md"
  "fleet-dev-csharp.md"
  "fleet-dev-fsharp.md"
  "fleet-dev-python.md"
  "fleet-dev-typescript.md"
  "fleet-dev-devops.md"
)
REMOVED_COUNT=0
for OLD_AGENT in "${OLD_AGENTS[@]}"; do
  if [ -f "$AGENTS_DIR/$OLD_AGENT" ]; then
    rm "$AGENTS_DIR/$OLD_AGENT"
    REMOVED_COUNT=$((REMOVED_COUNT + 1))
  fi
done
if [ "$REMOVED_COUNT" -gt 0 ]; then
  echo "  Removed $REMOVED_COUNT retired agent templates"
fi

# ── Done ──────────────────────────────────────────────────────────
echo ""
echo "Fleet Commander installed successfully!"
echo "  Hooks:      $HOOK_DIR"
echo "  Settings:   $SETTINGS"
echo "  Workflow:   $PROMPTS_DIR/fleet-workflow.md"
echo "  Agents:     $AGENTS_DIR"
echo "  Guidebooks: $GUIDES_DIR"

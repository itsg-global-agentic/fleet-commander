#!/bin/bash
set -euo pipefail
# Fleet Commander Installer
# Installs hook scripts, merges settings.json, deploys workflow prompt,
# and copies agent templates into a target repo's .claude directory.
#
# Usage: ./scripts/install.sh [--mode http|bash] [--port <n>] [/path/to/target/repo]
#   If no path given, auto-detects the git repo root from current directory.
#
# Options:
#   --mode http   Use native HTTP hooks (CC 2.1.62+, default).
#   --mode bash   Use legacy bash+curl hooks.
#   --port <n>    Fleet Commander server port for HTTP hooks (default $FLEET_PORT or 4680).

# Ensure standard Unix tools are on PATH — when Git Bash's usr/bin/bash.exe
# is invoked directly (not via git-bash.exe), /usr/bin may be missing.
export PATH="/usr/bin:/bin:$PATH"

# ── Validate required dependencies ────────────────────────────────
for cmd in git node sed; do
  command -v "$cmd" >/dev/null 2>&1 || { echo "Error: $cmd not found. Please install $cmd and ensure it is on your PATH." >&2; exit 1; }
done

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
FC_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# ── Parse CLI flags (--mode, --port) before positional target arg ──
# Default mode is 'http' (issue #735); operators can opt into 'bash' for
# CC < 2.1.62 or when troubleshooting. Port defaults to $FLEET_PORT or 4680.
INSTALL_MODE="http"
INSTALL_PORT="${FLEET_PORT:-4680}"
POSITIONAL_ARGS=()

while [ $# -gt 0 ]; do
  case "$1" in
    --mode)
      if [ -z "${2:-}" ]; then
        echo "Error: --mode requires a value (http|bash)" >&2
        exit 1
      fi
      INSTALL_MODE="$2"
      shift 2
      ;;
    --mode=*)
      INSTALL_MODE="${1#--mode=}"
      shift
      ;;
    --port)
      if [ -z "${2:-}" ]; then
        echo "Error: --port requires a value" >&2
        exit 1
      fi
      INSTALL_PORT="$2"
      shift 2
      ;;
    --port=*)
      INSTALL_PORT="${1#--port=}"
      shift
      ;;
    *)
      POSITIONAL_ARGS+=("$1")
      shift
      ;;
  esac
done

if [ "$INSTALL_MODE" != "http" ] && [ "$INSTALL_MODE" != "bash" ]; then
  echo "Error: --mode must be 'http' or 'bash' (got: $INSTALL_MODE)" >&2
  exit 1
fi

# Validate port — must be a positive integer
if ! echo "$INSTALL_PORT" | grep -Eq '^[0-9]+$' || [ "$INSTALL_PORT" -lt 1 ] || [ "$INSTALL_PORT" -gt 65535 ]; then
  echo "Error: --port must be an integer between 1 and 65535 (got: $INSTALL_PORT)" >&2
  exit 1
fi

# Restore positional args so the existing $1 logic below still works
set -- "${POSITIONAL_ARGS[@]:-}"

# ── Read FC version from package.json ────────────────────────────
FC_VERSION="unknown"
if [ -f "$FC_ROOT/package.json" ]; then
  FC_VERSION="$(node -e "try{console.log(JSON.parse(require('fs').readFileSync(process.argv[1],'utf-8')).version||'unknown')}catch{console.log('unknown')}" "$FC_ROOT/package.json")"
fi

# ── Validate that all install-time placeholders were replaced ────
# {{ISSUE_NUMBER}} is intentionally left — it is resolved at runtime by team-manager.
validate_placeholders() {
  local file="$1"
  local label="$2"
  local unreplaced
  unreplaced=$(grep -oE '\{\{[A-Za-z_]+\}\}' "$file" | grep -v '{{ISSUE_NUMBER}}' | sort -u || true)
  if [ -n "$unreplaced" ]; then
    echo "ERROR: Unreplaced placeholders found in $label:"
    echo "$unreplaced"
    exit 1
  fi
}

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

# Pick the settings.json source template based on mode and validate its
# presence. The bash template is the historical default; the http template
# is new in issue #735 and substitutes {{FLEET_PORT}} at install time.
if [ "$INSTALL_MODE" = "http" ]; then
  SETTINGS_EXAMPLE_NAME="settings.json.http.example"
else
  SETTINGS_EXAMPLE_NAME="settings.json.example"
fi
if [ ! -f "$FC_ROOT/hooks/$SETTINGS_EXAMPLE_NAME" ]; then
  echo "ERROR: hooks/$SETTINGS_EXAMPLE_NAME not found"
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
EXAMPLE="$FC_ROOT/hooks/$SETTINGS_EXAMPLE_NAME"

# A FC hook entry is identified by either:
#   - a bash command containing 'fleet-commander' (legacy bash mode), OR
#   - an http URL containing '/api/hooks/' (new HTTP mode).
# We always strip both kinds before re-adding the mode-specific entries so a
# reinstall with a different mode leaves no stale duplicates (issue #735).
if [ -f "$SETTINGS" ]; then
  # Merge Fleet Commander hook entries into existing settings,
  # preserving all existing hooks. Uses Node for reliable JSON handling.
  # FLEET_PORT placeholder in the http template is substituted at install time.
  node -e "
    const fs = require('fs');
    const existing = JSON.parse(fs.readFileSync(process.argv[1], 'utf-8'));
    const exampleRaw = fs.readFileSync(process.argv[2], 'utf-8');
    const fleetPort = process.argv[4];
    const example = JSON.parse(exampleRaw.replace(/{{FLEET_PORT}}/g, fleetPort));

    if (!existing.hooks) existing.hooks = {};

    // Returns true if the given entry is a Fleet Commander hook entry
    // (matches both bash and http styles).
    function isFcEntry(entry) {
      const hooks = (entry && entry.hooks) || [];
      return hooks.some(h => {
        if (h && typeof h.command === 'string' && h.command.includes('fleet-commander')) return true;
        if (h && typeof h.url === 'string' && h.url.includes('/api/hooks/')) return true;
        return false;
      });
    }

    // Track hook types whose FC entries are being stripped AND that are not
    // present in the new template — these are "stale" and worth reporting so
    // operators know the reinstall pruned drift (issue #760).
    const templateTypes = new Set(Object.keys(example.hooks || {}));
    const removedStaleTypes = [];

    // First pass: strip ALL existing FC entries across every hook type so a
    // reinstall with a different mode (or after a botched previous install)
    // does not leave bash and http entries coexisting (issue #735).
    for (const hookType of Object.keys(existing.hooks)) {
      const hadFc = existing.hooks[hookType].some(isFcEntry);
      existing.hooks[hookType] = existing.hooks[hookType].filter(e => !isFcEntry(e));
      if (existing.hooks[hookType].length === 0) {
        delete existing.hooks[hookType];
      }
      // Stale = had FC entries before AND the hook type is not in the new template
      if (hadFc && !templateTypes.has(hookType)) {
        removedStaleTypes.push(hookType);
      }
    }

    // Second pass: add this install's FC entries from the chosen template.
    for (const [hookType, entries] of Object.entries(example.hooks || {})) {
      for (const entry of entries) {
        if (!isFcEntry(entry)) continue;
        if (!existing.hooks[hookType]) existing.hooks[hookType] = [];
        existing.hooks[hookType].push(entry);
      }
    }

    existing._fleetCommanderVersion = process.argv[3];
    const tmpPath = process.argv[1] + '.tmp';
    try {
      fs.writeFileSync(tmpPath, JSON.stringify(existing, null, 2) + '\n');
      fs.renameSync(tmpPath, process.argv[1]);
    } finally {
      try { fs.unlinkSync(tmpPath); } catch {}
    }

    if (removedStaleTypes.length > 0) {
      removedStaleTypes.sort();
      console.log('  Removed ' + removedStaleTypes.length + ' stale hook entries: ' + removedStaleTypes.join(', '));
    }
  " "$SETTINGS" "$EXAMPLE" "$FC_VERSION" "$INSTALL_PORT"
  echo "  Merged hook entries into existing settings.json (v${FC_VERSION}, mode=${INSTALL_MODE}, port=${INSTALL_PORT})"
else
  mkdir -p "$TARGET/.claude"
  # Copy template and inject version stamp. FLEET_PORT placeholder in the
  # http template is substituted here as well.
  node -e "
    const fs = require('fs');
    const exampleRaw = fs.readFileSync(process.argv[1], 'utf-8');
    const fleetPort = process.argv[4];
    const data = JSON.parse(exampleRaw.replace(/{{FLEET_PORT}}/g, fleetPort));
    data._fleetCommanderVersion = process.argv[2];
    const tmpPath = process.argv[3] + '.tmp';
    try {
      fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2) + '\n');
      fs.renameSync(tmpPath, process.argv[3]);
    } finally {
      try { fs.unlinkSync(tmpPath); } catch {}
    }
  " "$EXAMPLE" "$FC_VERSION" "$SETTINGS" "$INSTALL_PORT"
  echo "  Created settings.json from template (v${FC_VERSION}, mode=${INSTALL_MODE}, port=${INSTALL_PORT})"
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
validate_placeholders "$WORKFLOW_TARGET" "workflow template ($WORKFLOW_TARGET)"

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
    validate_placeholders "$AGENTS_DIR/$AGENT_NAME" "agent template ($AGENT_NAME)"
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
    GUIDE_VERSION_STAMP="<!-- fleet-commander v${FC_VERSION} -->"
    # Strip source version stamp (line 1) and prepend install-time stamp
    GUIDE_TEMPLATE_CONTENT=$(sed '1{/^<!-- fleet-commander v/d}' "$GUIDE_FILE")
    NEW_GUIDE_CONTENT="${GUIDE_VERSION_STAMP}
${GUIDE_TEMPLATE_CONTENT}"

    if [ -f "$GUIDES_DIR/$GUIDE_NAME" ]; then
      EXISTING_GUIDE_STRIPPED=$(sed '1{/^<!-- fleet-commander v/d}' "$GUIDES_DIR/$GUIDE_NAME")
      if [ "$GUIDE_TEMPLATE_CONTENT" = "$EXISTING_GUIDE_STRIPPED" ]; then
        # Content unchanged — update version stamp if needed
        if [ "$(head -1 "$GUIDES_DIR/$GUIDE_NAME")" != "$GUIDE_VERSION_STAMP" ]; then
          printf '%s\n' "$NEW_GUIDE_CONTENT" > "$GUIDES_DIR/$GUIDE_NAME"
          echo "  Updated version stamp in guidebook $GUIDE_NAME"
        fi
      else
        # Content changed — backup + replace
        GUIDE_BACKUP="$GUIDES_DIR/$GUIDE_NAME.backup.$(date +%Y%m%d_%H%M%S)"
        cp "$GUIDES_DIR/$GUIDE_NAME" "$GUIDE_BACKUP"
        echo "  Backed up existing guidebook to $(basename "$GUIDE_BACKUP")"
        printf '%s\n' "$NEW_GUIDE_CONTENT" > "$GUIDES_DIR/$GUIDE_NAME"
      fi
    else
      printf '%s\n' "$NEW_GUIDE_CONTENT" > "$GUIDES_DIR/$GUIDE_NAME"
      GUIDE_COUNT=$((GUIDE_COUNT + 1))
    fi
  done
  echo "  Installed/updated guidebooks in $GUIDES_DIR (v${FC_VERSION}, $GUIDE_COUNT new)"
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

# ── 7. Ensure FC-managed files are in .gitignore ────────────────
# These paths must match getGitignoreEntries() in src/server/utils/fc-manifest.ts.
# Explicit file paths only — no globs, no directory-level entries.
FC_GITIGNORE_ENTRIES=(
  ".claude/agents/fleet-dev.md"
  ".claude/agents/fleet-planner.md"
  ".claude/agents/fleet-reviewer.md"
  ".claude/settings.json"
  ".claude/prompts/fleet-workflow.md"
  ".claude/scheduled_tasks.lock"
  "changes.md"
  "review.md"
  "plan.md"
  ".fleet-issue-context.md"
  ".fleet-pm-message"
)

GITIGNORE="$TARGET/.gitignore"
GITIGNORE_CONTENT=""
if [ -f "$GITIGNORE" ]; then
  # Normalize CRLF to LF for reliable matching
  GITIGNORE_CONTENT=$(tr -d '\r' < "$GITIGNORE")
fi

MISSING_ENTRIES=()
for ENTRY in "${FC_GITIGNORE_ENTRIES[@]}"; do
  # Check if the entry already exists as a standalone line (trimmed)
  if ! echo "$GITIGNORE_CONTENT" | grep -qxF "$ENTRY"; then
    MISSING_ENTRIES+=("$ENTRY")
  fi
done

if [ "${#MISSING_ENTRIES[@]}" -gt 0 ]; then
  # Ensure trailing newline before appending
  if [ -n "$GITIGNORE_CONTENT" ] && [ "${GITIGNORE_CONTENT: -1}" != $'\n' ]; then
    APPEND=$'\n'
  else
    APPEND=""
  fi
  APPEND+=$'\n'"# Fleet Commander managed files"
  for ENTRY in "${MISSING_ENTRIES[@]}"; do
    APPEND+=$'\n'"$ENTRY"
  done
  APPEND+=$'\n'
  # Write with LF line endings only
  printf '%s%s' "$GITIGNORE_CONTENT" "$APPEND" > "$GITIGNORE"
  echo "  Added ${#MISSING_ENTRIES[@]} entries to .gitignore"
else
  echo "  .gitignore already contains all FC entries"
fi

# ── Done ──────────────────────────────────────────────────────────
echo ""
echo "Fleet Commander installed successfully!"
echo "  Hooks:      $HOOK_DIR"
echo "  Settings:   $SETTINGS"
echo "  Workflow:   $PROMPTS_DIR/fleet-workflow.md"
echo "  Agents:     $AGENTS_DIR"
echo "  Guidebooks: $GUIDES_DIR"

#!/bin/bash
# Fleet Commander Installer
# Installs hook scripts, merges settings.json, and adds MCP server entry
# into a target repo's .claude directory.
#
# Usage: ./scripts/install.sh [/path/to/target/repo]
#   If no path given, auto-detects the git repo root from current directory.

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
FC_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# ── Validate required template files ───────────────────────────────
if [ ! -f "$FC_ROOT/templates/workflow.md" ]; then
  echo "ERROR: templates/workflow.md not found"
  exit 1
fi
if [ ! -f "$FC_ROOT/templates/next-issue.md" ]; then
  echo "ERROR: templates/next-issue.md not found"
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

# Copy all .sh files from the hooks directory
cp "$FC_ROOT/hooks/"*.sh "$HOOK_DIR/"
chmod +x "$HOOK_DIR/"*.sh

echo "  Copied hook scripts to $HOOK_DIR"

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

    fs.writeFileSync(process.argv[1], JSON.stringify(existing, null, 2) + '\n');
  " "$SETTINGS" "$EXAMPLE"
  echo "  Merged hook entries into existing settings.json"
else
  mkdir -p "$TARGET/.claude"
  cp "$EXAMPLE" "$SETTINGS"
  echo "  Created settings.json from template"
fi

# ── 3. Add MCP server entry to .mcp.json ─────────────────────────
MCP_JSON="$TARGET/.mcp.json"

# Convert FC_ROOT to a form usable in JSON (forward slashes)
FC_ROOT_JSON=$(printf '%s' "$FC_ROOT" | sed 's|\\|/|g')

if [ -f "$MCP_JSON" ]; then
  node -e "
    const fs = require('fs');
    const mcp = JSON.parse(fs.readFileSync(process.argv[1], 'utf-8'));
    if (!mcp.mcpServers) mcp.mcpServers = {};
    mcp.mcpServers['fleet-commander'] = {
      command: 'node',
      args: [process.argv[2] + '/mcp/dist/server.js'],
      env: { FLEET_SERVER_URL: 'http://localhost:4680' }
    };
    fs.writeFileSync(process.argv[1], JSON.stringify(mcp, null, 2) + '\n');
  " "$MCP_JSON" "$FC_ROOT_JSON"
else
  node -e "
    const fs = require('fs');
    const mcp = {
      mcpServers: {
        'fleet-commander': {
          command: 'node',
          args: [process.argv[1] + '/mcp/dist/server.js'],
          env: { FLEET_SERVER_URL: 'http://localhost:4680' }
        }
      }
    };
    fs.writeFileSync(process.argv[2], JSON.stringify(mcp, null, 2) + '\n');
  " "$FC_ROOT_JSON" "$MCP_JSON"
fi
echo "  Added MCP server entry to .mcp.json"

# ── 4. Install workflow template and command ─────────────────────
PROMPTS_DIR="$TARGET/.claude/prompts"
COMMANDS_DIR="$TARGET/.claude/commands"
mkdir -p "$PROMPTS_DIR"
mkdir -p "$COMMANDS_DIR"

# Derive project name from the target directory basename
PROJECT_NAME="$(basename "$TARGET")"
# Lowercase slug (replace spaces/special chars with hyphens)
project_slug="$(echo "$PROJECT_NAME" | tr '[:upper:]' '[:lower:]' | sed 's/[^a-z0-9]/-/g' | sed 's/--*/-/g' | sed 's/^-//;s/-$//')"

# Detect default branch
BASE_BRANCH="$(git -C "$TARGET" symbolic-ref refs/remotes/origin/HEAD 2>/dev/null | sed 's|refs/remotes/origin/||')" || true
if [ -z "$BASE_BRANCH" ]; then
  BASE_BRANCH="main"
fi

# Copy workflow template with placeholder replacement
WORKFLOW_TARGET="$PROMPTS_DIR/fleet-workflow.md"
NEW_WORKFLOW_CONTENT=$(sed -e "s|{{PROJECT_NAME}}|$PROJECT_NAME|g" \
    -e "s|{{project_slug}}|$project_slug|g" \
    -e "s|{{BASE_BRANCH}}|$BASE_BRANCH|g" \
    "$FC_ROOT/templates/workflow.md")

if [ -f "$WORKFLOW_TARGET" ]; then
  EXISTING_WORKFLOW_CONTENT=$(cat "$WORKFLOW_TARGET")
  if [ "$NEW_WORKFLOW_CONTENT" = "$EXISTING_WORKFLOW_CONTENT" ]; then
    echo "  Workflow template already up to date"
  else
    BACKUP="$WORKFLOW_TARGET.backup.$(date +%Y%m%d_%H%M%S)"
    cp "$WORKFLOW_TARGET" "$BACKUP"
    echo "  ⚠ Backed up existing workflow to $(basename "$BACKUP")"
    printf '%s\n' "$NEW_WORKFLOW_CONTENT" > "$WORKFLOW_TARGET"
    echo "  Installed workflow template to $WORKFLOW_TARGET"
  fi
else
  printf '%s\n' "$NEW_WORKFLOW_CONTENT" > "$WORKFLOW_TARGET"
  echo "  Installed workflow template to $WORKFLOW_TARGET"
fi
echo "    PROJECT_NAME=$PROJECT_NAME  project_slug=$project_slug  BASE_BRANCH=$BASE_BRANCH"

# Copy command template (no placeholders needed)
COMMAND_TARGET="$COMMANDS_DIR/next-issue.md"
if [ -f "$COMMAND_TARGET" ]; then
  if diff -q "$FC_ROOT/templates/next-issue.md" "$COMMAND_TARGET" > /dev/null 2>&1; then
    echo "  Command template already up to date"
  else
    BACKUP="$COMMAND_TARGET.backup.$(date +%Y%m%d_%H%M%S)"
    cp "$COMMAND_TARGET" "$BACKUP"
    echo "  ⚠ Backed up existing command to $(basename "$BACKUP")"
    cp "$FC_ROOT/templates/next-issue.md" "$COMMAND_TARGET"
    echo "  Installed command to $COMMAND_TARGET"
  fi
else
  cp "$FC_ROOT/templates/next-issue.md" "$COMMAND_TARGET"
  echo "  Installed command to $COMMAND_TARGET"
fi

# ── Done ──────────────────────────────────────────────────────────
echo ""
echo "Fleet Commander installed successfully!"
echo "  Hooks:    $HOOK_DIR"
echo "  Settings: $SETTINGS"
echo "  MCP:      $MCP_JSON"
echo "  Workflow: $PROMPTS_DIR/fleet-workflow.md"
echo "  Command:  $COMMANDS_DIR/next-issue.md"

#!/bin/bash
# Fleet Commander Uninstaller
# Removes hook scripts, cleans settings.json, and removes MCP server entry
# from a target repo's .claude directory.
#
# Usage: ./scripts/uninstall.sh [/path/to/target/repo]
#   If no path given, auto-detects the git repo root from current directory.
#
# Safe to run on a repo where Fleet Commander was never installed (no-op).

set -e

TARGET="${1:-$(git rev-parse --show-toplevel 2>/dev/null || echo "")}"
if [ -z "$TARGET" ]; then
  echo "Error: No target repo specified and not in a git repository"
  echo "Usage: $0 /path/to/target/repo"
  exit 1
fi

# Normalise path
TARGET="$(cd "$TARGET" && pwd)"

echo "Uninstalling Fleet Commander from: $TARGET"
echo ""

# ── 1. Remove hook directory ─────────────────────────────────────
HOOK_DIR="$TARGET/.claude/hooks/fleet-commander"
if [ -d "$HOOK_DIR" ]; then
  rm -rf "$HOOK_DIR"
  echo "  Removed $HOOK_DIR"
  # Clean up parent hooks dir if now empty
  rmdir "$TARGET/.claude/hooks" 2>/dev/null && echo "  Removed empty .claude/hooks/" || true
else
  echo "  Hook directory not found (already removed?)"
fi

# ── 2. Clean settings.json ───────────────────────────────────────
SETTINGS="$TARGET/.claude/settings.json"
if [ -f "$SETTINGS" ]; then
  node -e "
    const fs = require('fs');
    const settings = JSON.parse(fs.readFileSync(process.argv[1], 'utf-8'));

    if (settings.hooks) {
      for (const [hookType, entries] of Object.entries(settings.hooks)) {
        // Remove entries whose hook commands reference fleet-commander
        settings.hooks[hookType] = entries.filter(entry => {
          // Check nested hooks array (structured format)
          if (entry && entry.hooks && Array.isArray(entry.hooks)) {
            const hasFC = entry.hooks.some(
              h => typeof h.command === 'string' && h.command.includes('fleet-commander')
            );
            return !hasFC;
          }
          // Check direct command string
          if (typeof entry === 'object' && entry.command) {
            return !entry.command.includes('fleet-commander');
          }
          // Check plain string entry
          if (typeof entry === 'string') {
            return !entry.includes('fleet-commander');
          }
          return true;
        });

        // Remove empty arrays
        if (settings.hooks[hookType].length === 0) {
          delete settings.hooks[hookType];
        }
      }

      // Remove hooks key if empty
      if (Object.keys(settings.hooks).length === 0) {
        delete settings.hooks;
      }
    }

    // If settings object is now empty, remove the file entirely
    if (Object.keys(settings).length === 0) {
      fs.unlinkSync(process.argv[1]);
      console.log('  Removed empty settings.json');
    } else {
      fs.writeFileSync(process.argv[1], JSON.stringify(settings, null, 2) + '\n');
      console.log('  Cleaned Fleet Commander entries from settings.json');
    }
  " "$SETTINGS"
else
  echo "  settings.json not found (nothing to clean)"
fi

# ── 3. Remove MCP entry ──────────────────────────────────────────
MCP_JSON="$TARGET/.mcp.json"
if [ -f "$MCP_JSON" ]; then
  node -e "
    const fs = require('fs');
    const mcp = JSON.parse(fs.readFileSync(process.argv[1], 'utf-8'));

    if (mcp.mcpServers && mcp.mcpServers['fleet-commander']) {
      delete mcp.mcpServers['fleet-commander'];
    }

    // If no MCP servers remain, remove the file
    if (!mcp.mcpServers || Object.keys(mcp.mcpServers).length === 0) {
      fs.unlinkSync(process.argv[1]);
      console.log('  Removed empty .mcp.json');
    } else {
      fs.writeFileSync(process.argv[1], JSON.stringify(mcp, null, 2) + '\n');
      console.log('  Removed fleet-commander MCP entry from .mcp.json');
    }
  " "$MCP_JSON"
else
  echo "  .mcp.json not found (nothing to clean)"
fi

# ── 4. Remove workflow template and command ──────────────────────
WORKFLOW_FILE="$TARGET/.claude/prompts/fleet-workflow.md"
COMMAND_FILE="$TARGET/.claude/commands/next-issue.md"

if [ -f "$WORKFLOW_FILE" ]; then
  rm "$WORKFLOW_FILE"
  echo "  Removed $WORKFLOW_FILE"
  # Clean up empty prompts directory
  rmdir "$TARGET/.claude/prompts" 2>/dev/null && echo "  Removed empty .claude/prompts/" || true
else
  echo "  fleet-workflow.md not found (already removed?)"
fi

if [ -f "$COMMAND_FILE" ]; then
  rm "$COMMAND_FILE"
  echo "  Removed $COMMAND_FILE"
  # Clean up empty commands directory
  rmdir "$TARGET/.claude/commands" 2>/dev/null && echo "  Removed empty .claude/commands/" || true
else
  echo "  next-issue.md not found (already removed?)"
fi

# ── Done ──────────────────────────────────────────────────────────
echo ""
echo "Fleet Commander uninstalled successfully!"
echo "No Fleet Commander artifacts remain in $TARGET/.claude/"

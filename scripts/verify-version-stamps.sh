#!/bin/bash
# Verify that all template, hook, and prompt files carry a version stamp
# matching the version in package.json.
#
# Usage: bash scripts/verify-version-stamps.sh
#   Exits 0 if all stamps match, 1 if any mismatch is found.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

PKG_VERSION="$(node -e "console.log(JSON.parse(require('fs').readFileSync(process.argv[1],'utf-8')).version)" "$ROOT/package.json")"
ERRORS=0

echo "Verifying version stamps match package.json v${PKG_VERSION} ..."

# ── Check markdown files (.md) ──────────────────────────────────
# Expected first line: <!-- fleet-commander vX.Y.Z -->
check_md() {
  local file="$1"
  local rel="${file#$ROOT/}"
  local first_line
  first_line="$(head -1 "$file")"
  local expected="<!-- fleet-commander v${PKG_VERSION} -->"
  if [ "$first_line" != "$expected" ]; then
    echo "::error file=${rel}::Version stamp mismatch: expected '${expected}', got '${first_line}'"
    ERRORS=$((ERRORS + 1))
  fi
}

# ── Check agent markdown files (.md) ────────────────────────────
# Expected YAML frontmatter field: _fleetCommanderVersion: "X.Y.Z"
check_agent_md() {
  local file="$1"
  local rel="${file#$ROOT/}"
  local expected="_fleetCommanderVersion: \"${PKG_VERSION}\""
  if ! grep -q "^${expected}$" "$file" 2>/dev/null; then
    echo "::error file=${rel}::Version stamp mismatch: expected '${expected}' in YAML frontmatter"
    ERRORS=$((ERRORS + 1))
  fi
}

# ── Check shell files (.sh) ─────────────────────────────────────
# Expected second line: # fleet-commander vX.Y.Z
check_sh() {
  local file="$1"
  local rel="${file#$ROOT/}"
  local second_line
  second_line="$(sed -n '2p' "$file")"
  local expected="# fleet-commander v${PKG_VERSION}"
  if [ "$second_line" != "$expected" ]; then
    echo "::error file=${rel}::Version stamp mismatch: expected '${expected}', got '${second_line}'"
    ERRORS=$((ERRORS + 1))
  fi
}

# ── Markdown files to check ─────────────────────────────────────
# Agent files use YAML frontmatter field instead of line 1 HTML comment
for f in "$ROOT"/templates/agents/*.md; do
  [ -f "$f" ] || continue
  check_agent_md "$f"
done

for f in "$ROOT"/templates/guides/*.md; do
  [ -f "$f" ] || continue
  check_md "$f"
done

check_md "$ROOT/templates/workflow.md"
check_md "$ROOT/prompts/default-prompt.md"

# ── Shell files to check ────────────────────────────────────────
for f in "$ROOT"/hooks/*.sh; do
  [ -f "$f" ] || continue
  check_sh "$f"
done

# ── Summary ──────────────────────────────────────────────────────
if [ "$ERRORS" -gt 0 ]; then
  echo ""
  echo "FAILED: ${ERRORS} file(s) have mismatched version stamps."
  exit 1
else
  echo "OK: All version stamps match v${PKG_VERSION}."
  exit 0
fi

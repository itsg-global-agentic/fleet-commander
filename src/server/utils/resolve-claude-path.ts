// =============================================================================
// Resolve Claude CLI executable path
// =============================================================================
// On Windows, `spawn('claude', ...)` with `shell: false` fails because Node
// cannot resolve bare command names via PATH without a shell. We use `where`
// to find the full path to claude.exe once, then cache the result.
//
// On non-Windows platforms, the bare command name works fine with shell: false.
// =============================================================================

import { execSync } from 'child_process';
import config from '../config.js';

let _resolvedClaudePath: string | null = null;

export function resolveClaudePath(): string {
  if (_resolvedClaudePath) return _resolvedClaudePath;

  if (process.platform === 'win32') {
    try {
      const result = execSync('where claude.exe', {
        encoding: 'utf-8',
        timeout: 5000,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      const firstLine = result.trim().split('\n')[0]?.trim();
      if (firstLine) {
        _resolvedClaudePath = firstLine;
        console.log(`[resolveClaudePath] Resolved claude path: ${_resolvedClaudePath}`);
        return _resolvedClaudePath;
      }
    } catch {
      // `where` failed — try `where claude` without .exe extension
      try {
        const result = execSync('where claude', {
          encoding: 'utf-8',
          timeout: 5000,
          stdio: ['pipe', 'pipe', 'pipe'],
        });
        const firstLine = result.trim().split('\n')[0]?.trim();
        if (firstLine) {
          _resolvedClaudePath = firstLine;
          console.log(`[resolveClaudePath] Resolved claude path: ${_resolvedClaudePath}`);
          return _resolvedClaudePath;
        }
      } catch {
        // Fall through to default
      }
    }
  }

  // Non-Windows or resolution failed — use configured command as-is
  _resolvedClaudePath = config.claudeCmd;
  console.log(`[resolveClaudePath] Using claude command: ${_resolvedClaudePath}`);
  return _resolvedClaudePath;
}

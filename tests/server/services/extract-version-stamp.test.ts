// =============================================================================
// Fleet Commander — extractVersionStamp Tests
// =============================================================================
// Verifies the version-stamp parser reads enough of the file to find stamps
// that live past the first few hundred bytes (e.g. fleet-reviewer.md with a
// long YAML frontmatter). Regression test for issue #720.
// =============================================================================

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { extractVersionStamp } from '../../../src/server/services/project-service.js';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-version-stamp-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function writeFile(name: string, content: string): string {
  const p = path.join(tmpDir, name);
  fs.writeFileSync(p, content);
  return p;
}

describe('extractVersionStamp', () => {
  it('reads YAML frontmatter stamp at the top', () => {
    const file = writeFile('short.md', `---\nname: foo\n_fleetCommanderVersion: "1.2.3"\n---\nbody\n`);
    expect(extractVersionStamp(file)).toBe('1.2.3');
  });

  it('reads shell-script stamp on line 2', () => {
    const file = writeFile('hook.sh', `#!/bin/sh\n# fleet-commander v0.0.24\necho hi\n`);
    expect(extractVersionStamp(file)).toBe('0.0.24');
  });

  it('finds YAML stamp past byte 512 (regression: #720)', () => {
    // Simulate fleet-reviewer.md shape: long description + comment lines that
    // push _fleetCommanderVersion past the historic 512-byte read window.
    const padding = 'x'.repeat(800);
    const content =
      `---\n` +
      `name: fleet-reviewer\n` +
      `description: ${padding}\n` +
      `model: inherit\n` +
      `_fleetCommanderVersion: "0.0.24"\n` +
      `---\n` +
      `body\n`;
    expect(content.indexOf('_fleetCommanderVersion')).toBeGreaterThan(512);

    const file = writeFile('long-frontmatter.md', content);
    expect(extractVersionStamp(file)).toBe('0.0.24');
  });

  it('returns undefined when no stamp is present', () => {
    const file = writeFile('plain.md', `# hello\n\nno stamp here\n`);
    expect(extractVersionStamp(file)).toBeUndefined();
  });

  it('returns undefined for a missing file', () => {
    expect(extractVersionStamp(path.join(tmpDir, 'does-not-exist.md'))).toBeUndefined();
  });
});

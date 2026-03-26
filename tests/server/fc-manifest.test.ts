// =============================================================================
// Fleet Commander — FC Manifest Tests
// =============================================================================

import { describe, it, expect } from 'vitest';
import {
  getHookFiles,
  getAgentFiles,
  getGuideFiles,
  getWorkflowFile,
  getSettingsExampleFile,
  getHookEventTypes,
  getAllManagedFiles,
} from '../../src/server/utils/fc-manifest.js';

// ---------------------------------------------------------------------------
// getHookFiles
// ---------------------------------------------------------------------------

describe('getHookFiles', () => {
  it('returns an array of .sh filenames', () => {
    const hooks = getHookFiles();
    expect(hooks.length).toBeGreaterThan(0);
    for (const hook of hooks) {
      expect(hook).toMatch(/\.sh$/);
    }
  });

  it('includes well-known hook files', () => {
    const hooks = getHookFiles();
    expect(hooks).toContain('send_event.sh');
    expect(hooks).toContain('on_session_start.sh');
    expect(hooks).toContain('on_session_end.sh');
    expect(hooks).toContain('on_stop.sh');
    expect(hooks).toContain('on_task_created.sh');
  });

  it('returns filenames sorted alphabetically', () => {
    const hooks = getHookFiles();
    const sorted = [...hooks].sort();
    expect(hooks).toEqual(sorted);
  });
});

// ---------------------------------------------------------------------------
// getAgentFiles
// ---------------------------------------------------------------------------

describe('getAgentFiles', () => {
  it('returns an array of .md filenames', () => {
    const agents = getAgentFiles();
    expect(agents.length).toBeGreaterThan(0);
    for (const agent of agents) {
      expect(agent).toMatch(/\.md$/);
    }
  });

  it('includes well-known agent files', () => {
    const agents = getAgentFiles();
    expect(agents).toContain('fleet-planner.md');
    expect(agents).toContain('fleet-dev.md');
    expect(agents).toContain('fleet-reviewer.md');
  });
});

// ---------------------------------------------------------------------------
// getGuideFiles
// ---------------------------------------------------------------------------

describe('getGuideFiles', () => {
  it('returns an array of .md filenames', () => {
    const guides = getGuideFiles();
    expect(guides.length).toBeGreaterThan(0);
    for (const guide of guides) {
      expect(guide).toMatch(/\.md$/);
    }
  });

  it('includes well-known guide files', () => {
    const guides = getGuideFiles();
    expect(guides).toContain('typescript-conventions.md');
  });
});

// ---------------------------------------------------------------------------
// getWorkflowFile / getSettingsExampleFile
// ---------------------------------------------------------------------------

describe('getWorkflowFile', () => {
  it('returns the workflow filename', () => {
    expect(getWorkflowFile()).toBe('fleet-workflow.md');
  });
});

describe('getSettingsExampleFile', () => {
  it('returns the settings example filename', () => {
    expect(getSettingsExampleFile()).toBe('settings.json.example');
  });
});

// ---------------------------------------------------------------------------
// getHookEventTypes
// ---------------------------------------------------------------------------

describe('getHookEventTypes', () => {
  it('returns an array of event type strings', () => {
    const types = getHookEventTypes();
    expect(types.length).toBeGreaterThan(0);
  });

  it('includes well-known event types', () => {
    const types = getHookEventTypes();
    expect(types).toContain('SessionStart');
    expect(types).toContain('SessionEnd');
    expect(types).toContain('Stop');
    expect(types).toContain('TaskCreated');
  });

  it('returns event types sorted alphabetically', () => {
    const types = getHookEventTypes();
    const sorted = [...types].sort();
    expect(types).toEqual(sorted);
  });
});

// ---------------------------------------------------------------------------
// getAllManagedFiles
// ---------------------------------------------------------------------------

describe('getAllManagedFiles', () => {
  it('returns a manifest with all categories', () => {
    const manifest = getAllManagedFiles();
    expect(manifest.hooks.length).toBeGreaterThan(0);
    expect(manifest.agents.length).toBeGreaterThan(0);
    expect(manifest.guides.length).toBeGreaterThan(0);
    expect(manifest.workflow).toBe('fleet-workflow.md');
    expect(manifest.settingsExample).toBe('settings.json.example');
  });

  it('hooks match getHookFiles()', () => {
    const manifest = getAllManagedFiles();
    expect(manifest.hooks).toEqual(getHookFiles());
  });

  it('agents match getAgentFiles()', () => {
    const manifest = getAllManagedFiles();
    expect(manifest.agents).toEqual(getAgentFiles());
  });

  it('guides match getGuideFiles()', () => {
    const manifest = getAllManagedFiles();
    expect(manifest.guides).toEqual(getGuideFiles());
  });
});

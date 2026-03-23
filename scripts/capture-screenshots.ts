/**
 * Playwright screenshot capture script for Fleet Commander README.
 *
 * Seeds a temporary SQLite database with representative data (teams in various
 * states, PRs, events), starts the Fastify server, navigates to each view,
 * and captures screenshots at 1280x800. Screenshots are saved to
 * docs/screenshots/ for use in README.md.
 *
 * Usage:
 *   npx tsx scripts/capture-screenshots.ts
 *
 * Prerequisites:
 *   npm install --save-dev playwright
 *   npx playwright install chromium
 */

import { chromium, type Browser, type Page } from 'playwright';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..');

const SCREENSHOT_DIR = path.join(ROOT, 'docs', 'screenshots');
const TEMP_DB = path.join(ROOT, 'fleet-screenshots-temp.db');
const PORT = 14680; // Use a non-standard port to avoid conflicts
const BASE_URL = `http://localhost:${PORT}`;

const VIEWPORT = { width: 1280, height: 800 };

// ---------------------------------------------------------------------------
// Seed data
// ---------------------------------------------------------------------------

interface SeedProject {
  name: string;
  repoPath: string;
  githubRepo: string;
  maxActiveTeams: number;
}

interface SeedTeam {
  issueNumber: number;
  issueTitle: string;
  projectId: number;
  worktreeName: string;
  branchName: string;
  status: string;
  phase: string;
  prNumber: number | null;
  launchedAt: string;
  lastEventAt: string;
}

interface SeedPR {
  prNumber: number;
  teamId: number;
  title: string;
  state: string;
  ciStatus: string;
  mergeStatus: string;
}

interface SeedEvent {
  teamId: number;
  eventType: string;
  toolName: string | null;
  payload: string;
}

const SEED_PROJECTS: SeedProject[] = [
  {
    name: 'fleet-commander',
    repoPath: '/repos/fleet-commander',
    githubRepo: 'hubertciebiada/fleet-commander',
    maxActiveTeams: 5,
  },
  {
    name: 'my-web-app',
    repoPath: '/repos/my-web-app',
    githubRepo: 'org/my-web-app',
    maxActiveTeams: 3,
  },
];

function minutesAgo(min: number): string {
  return new Date(Date.now() - min * 60_000).toISOString();
}

const SEED_TEAMS: SeedTeam[] = [
  {
    issueNumber: 274,
    issueTitle: 'README overhaul with screenshots',
    projectId: 1,
    worktreeName: 'fleet-commander-274',
    branchName: 'feat/274-readme-overhaul',
    status: 'running',
    phase: 'implementing',
    prNumber: 301,
    launchedAt: minutesAgo(45),
    lastEventAt: minutesAgo(1),
  },
  {
    issueNumber: 330,
    issueTitle: 'MCP tool reference documentation',
    projectId: 1,
    worktreeName: 'fleet-commander-330',
    branchName: 'feat/330-mcp-docs',
    status: 'running',
    phase: 'reviewing',
    prNumber: 302,
    launchedAt: minutesAgo(30),
    lastEventAt: minutesAgo(2),
  },
  {
    issueNumber: 105,
    issueTitle: 'Fix CI pipeline for Windows',
    projectId: 1,
    worktreeName: 'fleet-commander-105',
    branchName: 'fix/105-ci-windows',
    status: 'idle',
    phase: 'implementing',
    prNumber: 303,
    launchedAt: minutesAgo(60),
    lastEventAt: minutesAgo(4),
  },
  {
    issueNumber: 42,
    issueTitle: 'Add search feature to dashboard',
    projectId: 2,
    worktreeName: 'my-web-app-42',
    branchName: 'feat/42-add-search',
    status: 'done',
    phase: 'done',
    prNumber: 201,
    launchedAt: minutesAgo(120),
    lastEventAt: minutesAgo(90),
  },
  {
    issueNumber: 55,
    issueTitle: 'Refactor authentication module',
    projectId: 2,
    worktreeName: 'my-web-app-55',
    branchName: 'feat/55-refactor-auth',
    status: 'stuck',
    phase: 'implementing',
    prNumber: null,
    launchedAt: minutesAgo(90),
    lastEventAt: minutesAgo(8),
  },
  {
    issueNumber: 200,
    issueTitle: 'Upgrade dependencies to latest',
    projectId: 1,
    worktreeName: 'fleet-commander-200',
    branchName: 'chore/200-upgrade-deps',
    status: 'queued',
    phase: 'init',
    prNumber: null,
    launchedAt: minutesAgo(5),
    lastEventAt: minutesAgo(5),
  },
];

const SEED_PRS: SeedPR[] = [
  { prNumber: 301, teamId: 1, title: 'feat: README overhaul with screenshots', state: 'OPEN', ciStatus: 'passing', mergeStatus: 'clean' },
  { prNumber: 302, teamId: 2, title: 'feat: MCP tool reference documentation', state: 'OPEN', ciStatus: 'pending', mergeStatus: 'clean' },
  { prNumber: 303, teamId: 3, title: 'fix: CI pipeline for Windows', state: 'OPEN', ciStatus: 'failing', mergeStatus: 'dirty' },
  { prNumber: 201, teamId: 4, title: 'feat: Add search feature', state: 'MERGED', ciStatus: 'passing', mergeStatus: 'clean' },
];

const SEED_EVENTS: SeedEvent[] = [
  { teamId: 1, eventType: 'session_start', toolName: null, payload: '{}' },
  { teamId: 1, eventType: 'tool_use', toolName: 'Read', payload: '{"file":"README.md"}' },
  { teamId: 1, eventType: 'tool_use', toolName: 'Edit', payload: '{"file":"README.md"}' },
  { teamId: 1, eventType: 'tool_use', toolName: 'Write', payload: '{"file":"scripts/capture-screenshots.ts"}' },
  { teamId: 2, eventType: 'session_start', toolName: null, payload: '{}' },
  { teamId: 2, eventType: 'tool_use', toolName: 'Read', payload: '{"file":"docs/mcp.md"}' },
  { teamId: 3, eventType: 'session_start', toolName: null, payload: '{}' },
  { teamId: 3, eventType: 'tool_use', toolName: 'Bash', payload: '{"command":"npm test"}' },
  { teamId: 4, eventType: 'session_start', toolName: null, payload: '{}' },
  { teamId: 4, eventType: 'session_end', toolName: null, payload: '{}' },
  { teamId: 5, eventType: 'session_start', toolName: null, payload: '{}' },
  { teamId: 5, eventType: 'tool_use', toolName: 'Grep', payload: '{"pattern":"auth"}' },
];

// ---------------------------------------------------------------------------
// Database seeding via better-sqlite3
// ---------------------------------------------------------------------------

async function seedDatabase(): Promise<void> {
  // Clean up any previous temp DB
  if (fs.existsSync(TEMP_DB)) {
    fs.unlinkSync(TEMP_DB);
  }
  if (fs.existsSync(`${TEMP_DB}-wal`)) {
    fs.unlinkSync(`${TEMP_DB}-wal`);
  }
  if (fs.existsSync(`${TEMP_DB}-shm`)) {
    fs.unlinkSync(`${TEMP_DB}-shm`);
  }

  // Use better-sqlite3 dynamically — the same driver the app uses
  const Database = (await import('better-sqlite3')).default;
  const db = new Database(TEMP_DB);
  db.pragma('journal_mode = WAL');

  // Apply schema
  const schemaPath = path.join(ROOT, 'src', 'server', 'schema.sql');
  const schema = fs.readFileSync(schemaPath, 'utf-8');
  db.exec(schema);

  // Insert projects
  const insertProject = db.prepare(
    `INSERT INTO projects (name, repo_path, github_repo, max_active_teams, hooks_installed)
     VALUES (?, ?, ?, ?, 1)`
  );
  for (const p of SEED_PROJECTS) {
    insertProject.run(p.name, p.repoPath, p.githubRepo, p.maxActiveTeams);
  }

  // Insert teams
  const insertTeam = db.prepare(
    `INSERT INTO teams (issue_number, issue_title, project_id, worktree_name, branch_name,
       status, phase, pr_number, launched_at, last_event_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  for (const t of SEED_TEAMS) {
    insertTeam.run(
      t.issueNumber, t.issueTitle, t.projectId, t.worktreeName, t.branchName,
      t.status, t.phase, t.prNumber, t.launchedAt, t.lastEventAt
    );
  }

  // Insert PRs
  const insertPR = db.prepare(
    `INSERT INTO pull_requests (pr_number, team_id, title, state, ci_status, merge_status)
     VALUES (?, ?, ?, ?, ?, ?)`
  );
  for (const pr of SEED_PRS) {
    insertPR.run(pr.prNumber, pr.teamId, pr.title, pr.state, pr.ciStatus, pr.mergeStatus);
  }

  // Insert events
  const insertEvent = db.prepare(
    `INSERT INTO events (team_id, event_type, tool_name, payload) VALUES (?, ?, ?, ?)`
  );
  for (const e of SEED_EVENTS) {
    insertEvent.run(e.teamId, e.eventType, e.toolName, e.payload);
  }

  // Insert usage snapshots
  db.prepare(
    `INSERT INTO usage_snapshots (daily_percent, weekly_percent, sonnet_percent, extra_percent)
     VALUES (?, ?, ?, ?)`
  ).run(45, 30, 60, 5);

  db.close();
  console.log(`Seeded temporary database: ${TEMP_DB}`);
}

// ---------------------------------------------------------------------------
// Server management
// ---------------------------------------------------------------------------

let serverProcess: ReturnType<typeof import('child_process').spawn> | null = null;

async function startServer(): Promise<void> {
  const { spawn } = await import('child_process');

  const serverEntry = path.join(ROOT, 'dist', 'server', 'index.js');
  if (!fs.existsSync(serverEntry)) {
    throw new Error(
      `Server entry not found at ${serverEntry}. Run "npm run build" first.`
    );
  }

  serverProcess = spawn('node', [serverEntry], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(PORT),
      FLEET_DB_PATH: TEMP_DB,
      LOG_LEVEL: 'warn',
      FLEET_GITHUB_POLL_MS: '999999999', // Disable polling
      FLEET_STUCK_CHECK_MS: '999999999', // Disable stuck detection
      FLEET_USAGE_POLL_MS: '999999999',  // Disable usage polling
      FLEET_ISSUE_POLL_MS: '999999999',  // Disable issue polling
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  serverProcess.stderr?.on('data', (data: Buffer) => {
    const msg = data.toString();
    if (msg.includes('Error') || msg.includes('error')) {
      console.error('[server stderr]', msg.trim());
    }
  });

  // Wait for the server to be ready
  const maxWait = 30_000;
  const start = Date.now();
  while (Date.now() - start < maxWait) {
    try {
      const response = await fetch(`${BASE_URL}/api/health`);
      if (response.ok) {
        console.log(`Server ready on port ${PORT}`);
        return;
      }
    } catch {
      // Server not ready yet
    }
    await sleep(500);
  }

  throw new Error(`Server failed to start within ${maxWait / 1000}s`);
}

function stopServer(): void {
  if (serverProcess) {
    serverProcess.kill('SIGTERM');
    serverProcess = null;
    console.log('Server stopped');
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Screenshot capture
// ---------------------------------------------------------------------------

interface ScreenshotSpec {
  name: string;
  path: string;
  beforeCapture?: (page: Page) => Promise<void>;
}

const SCREENSHOTS: ScreenshotSpec[] = [
  {
    name: 'fleet-grid',
    path: '/',
  },
  {
    name: 'team-detail',
    path: '/',
    beforeCapture: async (page: Page) => {
      // Click on the first running team row to open the detail panel
      const teamRow = page.locator('tr').filter({ hasText: 'README overhaul' }).first();
      if (await teamRow.isVisible({ timeout: 5000 })) {
        await teamRow.click();
        await sleep(1000); // Wait for slide-over animation
      }
    },
  },
  {
    name: 'issue-tree',
    path: '/issues',
  },
  {
    name: 'comm-graph',
    path: '/',
    beforeCapture: async (page: Page) => {
      // Open a team detail, then click the "team" tab to see the CommGraph
      const teamRow = page.locator('tr').filter({ hasText: 'README overhaul' }).first();
      if (await teamRow.isVisible({ timeout: 5000 })) {
        await teamRow.click();
        await sleep(1000);
        // Look for the "team" tab button
        const teamTab = page.locator('button', { hasText: /^team$/i }).first();
        if (await teamTab.isVisible({ timeout: 3000 })) {
          await teamTab.click();
          await sleep(1000);
        }
      }
    },
  },
  {
    name: 'lifecycle',
    path: '/lifecycle',
  },
  {
    name: 'usage',
    path: '/usage',
  },
  {
    name: 'projects',
    path: '/projects',
  },
];

async function captureScreenshots(): Promise<void> {
  // Ensure output directory exists
  fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });

  const browser: Browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: VIEWPORT,
    colorScheme: 'dark',
  });

  try {
    for (const spec of SCREENSHOTS) {
      const page: Page = await context.newPage();
      console.log(`Capturing: ${spec.name} (${spec.path})`);

      await page.goto(`${BASE_URL}${spec.path}`, { waitUntil: 'networkidle' });

      // Allow rendering to settle
      await sleep(2000);

      if (spec.beforeCapture) {
        await spec.beforeCapture(page);
      }

      const outputPath = path.join(SCREENSHOT_DIR, `${spec.name}.png`);
      await page.screenshot({ path: outputPath, fullPage: false });
      console.log(`  -> ${outputPath}`);

      await page.close();
    }
  } finally {
    await browser.close();
  }
}

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------

function cleanup(): void {
  stopServer();

  // Remove temporary database files
  for (const suffix of ['', '-wal', '-shm']) {
    const file = `${TEMP_DB}${suffix}`;
    if (fs.existsSync(file)) {
      fs.unlinkSync(file);
    }
  }
  console.log('Cleaned up temporary database');
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  console.log('Fleet Commander Screenshot Capture');
  console.log('==================================\n');

  try {
    // 1. Seed database
    console.log('Step 1: Seeding database...');
    await seedDatabase();

    // 2. Start server
    console.log('\nStep 2: Starting server...');
    await startServer();

    // 3. Capture screenshots
    console.log('\nStep 3: Capturing screenshots...');
    await captureScreenshots();

    console.log('\nDone! Screenshots saved to docs/screenshots/');
  } catch (err) {
    console.error('\nFailed:', err);
    process.exitCode = 1;
  } finally {
    cleanup();
  }
}

main();

// =============================================================================
// Fleet Commander — CC Query Service
// =============================================================================
// Spawns Claude Code in -p mode for quick, ad-hoc structured queries.
// All queries are predefined as typed methods — no freeform prompting.
// Uses a concurrency queue (max 1 at a time) to avoid overloading CC.
// =============================================================================

import { spawn } from 'child_process';
import os from 'os';
import config from '../config.js';
import { resolveClaudePath } from '../utils/resolve-claude-path.js';
import { findGitBash } from '../utils/find-git-bash.js';
import type {
  CCQueryResult,
  PrioritizedIssue,
  ComplexityEstimate,
  IssueSummary,
  QueueConstraints,
  AssignmentPlan,
} from '../../shared/types.js';

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

interface ExecuteOptions<T> {
  prompt: string;
  jsonSchema: Record<string, unknown>;
  /** Optional timeout override in milliseconds; defaults to config.ccQueryTimeoutMs */
  timeoutMs?: number;
}

// ---------------------------------------------------------------------------
// CCQueryService (singleton)
// ---------------------------------------------------------------------------

export class CCQueryService {
  private static _instance: CCQueryService | null = null;
  private _queue: Array<{ run: () => void }> = [];
  private _running = false;

  private constructor() {}

  static getInstance(): CCQueryService {
    if (!CCQueryService._instance) {
      CCQueryService._instance = new CCQueryService();
    }
    return CCQueryService._instance;
  }

  // -------------------------------------------------------------------------
  // Concurrency queue — max 1 concurrent query
  // -------------------------------------------------------------------------

  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const run = () => {
        fn().then(resolve, reject).finally(() => {
          this._running = false;
          this.dequeue();
        });
      };

      if (!this._running) {
        this._running = true;
        run();
      } else {
        this._queue.push({ run });
      }
    });
  }

  private dequeue(): void {
    const next = this._queue.shift();
    if (next) {
      this._running = true;
      next.run();
    }
  }

  // -------------------------------------------------------------------------
  // Private execute method — spawns CC in -p mode
  // -------------------------------------------------------------------------

  private execute<T>(opts: ExecuteOptions<T>): Promise<CCQueryResult<T>> {
    return this.enqueue(() => this._executeWithRetry<T>(opts));
  }

  private async _executeWithRetry<T>(opts: ExecuteOptions<T>): Promise<CCQueryResult<T>> {
    const maxRetries = config.ccQueryMaxRetries;
    let lastResult: CCQueryResult<T> | undefined;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      const result = await this._executeImpl<T>(opts);

      // Success — return immediately
      if (result.success) {
        return result;
      }

      lastResult = result;

      // Only retry transient "no structured data" failures:
      // - Must be exit code 0 (no non-zero exit, no spawn error, no timeout)
      // - Error must start with "CC returned no structured data"
      const isTransient =
        !!result.error?.startsWith('CC returned no structured data');

      if (!isTransient || attempt >= maxRetries) {
        break;
      }

      console.warn(
        `[CCQuery] Transient failure (attempt ${attempt + 1}/${maxRetries + 1}), retrying in 1.5s: ${result.error}`,
      );
      await new Promise((r) => setTimeout(r, 1500));
    }

    return lastResult!;
  }

  private _executeImpl<T>(opts: ExecuteOptions<T>): Promise<CCQueryResult<T>> {
    return new Promise<CCQueryResult<T>>((resolve) => {
      const start = Date.now();
      const claudePath = resolveClaudePath();

      const args = [
        '-p', opts.prompt,
        '--output-format', 'json',
        '--no-session-persistence',
        '--max-turns', String(config.ccQueryMaxTurns),
        '--model', config.ccQueryModel,
        '--tools', '',
        '--strict-mcp-config',
        '--disable-slash-commands',
        '--json-schema', JSON.stringify(opts.jsonSchema),
      ];

      const spawnEnv: Record<string, string> = { ...process.env as Record<string, string> };
      const gitBash = findGitBash();
      if (gitBash) {
        spawnEnv['CLAUDE_CODE_GIT_BASH_PATH'] = gitBash;
      }

      const child = spawn(claudePath, args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        cwd: os.tmpdir(),
        windowsHide: true,
        env: spawnEnv,
      });

      let stdout = '';
      let stderr = '';
      let timedOut = false;
      const effectiveTimeout = opts.timeoutMs ?? config.ccQueryTimeoutMs;

      const timeout = setTimeout(() => {
        timedOut = true;
        try {
          if (process.platform === 'win32') {
            // Use taskkill for reliable Windows process tree kill
            spawn('taskkill', ['/F', '/T', '/PID', String(child.pid)], {
              stdio: 'pipe',
              windowsHide: true,
            });
          } else {
            child.kill('SIGKILL');
          }
        } catch {
          // Best effort
        }
      }, effectiveTimeout);

      child.stdout?.on('data', (chunk: Buffer) => {
        stdout += chunk.toString();
      });

      child.stderr?.on('data', (chunk: Buffer) => {
        stderr += chunk.toString();
      });

      child.on('close', (code) => {
        clearTimeout(timeout);
        const durationMs = Date.now() - start;

        if (timedOut) {
          resolve({
            success: false,
            costUsd: 0,
            durationMs,
            error: `Query timed out after ${effectiveTimeout}ms`,
          });
          return;
        }

        if (code !== 0) {
          resolve({
            success: false,
            costUsd: 0,
            durationMs,
            error: `CC exited with code ${code}: ${stderr.trim().substring(0, 500)}`,
          });
          return;
        }

        // Defense-in-depth: strip non-JSON prefix lines before parsing.
        // CC may emit warnings or debug text before the JSON payload.
        const jsonStart = stdout.indexOf('{');
        const cleanStdout = jsonStart >= 0 ? stdout.substring(jsonStart) : stdout;

        // Parse the JSON output from CC
        try {
          const parsed = JSON.parse(cleanStdout);
          // CC --output-format json returns total_cost_usd (not cost_usd)
          const costUsd = parsed.total_cost_usd ?? 0;

          // Prefer structured_output (populated when --json-schema is used),
          // fall back to parsing result text for backward compatibility
          let data: T | undefined;
          if (parsed.structured_output != null) {
            data = parsed.structured_output as T;
          } else if (typeof parsed.result === 'string' && parsed.result) {
            try {
              data = JSON.parse(parsed.result) as T;
            } catch {
              // result is plain text, not JSON
            }
          }

          const resultText = parsed.result ?? '';
          const textValue = typeof resultText === 'string' ? resultText : JSON.stringify(resultText);

          if (data === undefined) {
            // Include diagnostic details: subtype, stop_reason, and raw stdout snippet
            const subtype = parsed.subtype ?? 'unknown';
            const stopReason = parsed.stop_reason ?? 'unknown';
            console.warn(
              `[CCQuery] CC exited 0 but returned no structured data.`,
              `subtype=${subtype} stop_reason=${stopReason}`,
              `stdout (first 200): ${stdout.substring(0, 200)}`,
              stderr ? `stderr: ${stderr.substring(0, 500)}` : '',
            );
            resolve({
              success: false,
              text: textValue,
              costUsd: typeof costUsd === 'number' ? costUsd : 0,
              durationMs: parsed.duration_ms ?? durationMs,
              error: `CC returned no structured data (subtype=${subtype}, stop_reason=${stopReason}, stdout=${stdout.substring(0, 200)})`,
            });
          } else {
            resolve({
              success: true,
              data,
              text: textValue,
              costUsd: typeof costUsd === 'number' ? costUsd : 0,
              durationMs: parsed.duration_ms ?? durationMs,
            });
          }
        } catch {
          // stdout was not valid JSON — return as text with diagnostic snippet
          console.warn(
            `[CCQuery] CC exited 0 but stdout was not valid JSON.`,
            `stdout (first 200): ${stdout.substring(0, 200)}`,
            stderr ? `stderr: ${stderr.substring(0, 500)}` : '',
          );
          resolve({
            success: false,
            text: stdout.trim(),
            costUsd: 0,
            durationMs,
            error: `CC returned no structured data (stdout=${stdout.substring(0, 200)})`,
          });
        }
      });

      child.on('error', (err) => {
        clearTimeout(timeout);
        resolve({
          success: false,
          costUsd: 0,
          durationMs: Date.now() - start,
          error: `Failed to spawn CC: ${err.message}`,
        });
      });
    });
  }

  // -------------------------------------------------------------------------
  // Public query methods (predefined, typed)
  // -------------------------------------------------------------------------

  async prioritizeIssues(
    issues: { number: number; title: string }[],
  ): Promise<CCQueryResult<PrioritizedIssue[]>> {
    const issueList = issues.map((i) => `#${i.number}: ${i.title}`).join('\n');
    const prompt = [
      'You are a senior engineering manager prioritizing a backlog.',
      'Analyze the following issues and assign each a priority from 1 (highest/most urgent) to 10 (lowest/least urgent).',
      'Also categorize each issue as one of: critical-bug, bug, perf, feature, refactor, cleanup.',
      'Consider urgency, user impact, severity, and dependencies.',
      '',
      'Issues:',
      issueList,
      '',
      'Return a JSON array of objects with: number, title, priority (1-10), category, reason.',
    ].join('\n');

    const jsonSchema = {
      type: 'object',
      properties: {
        items: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              number: { type: 'number' },
              title: { type: 'string' },
              priority: { type: 'number' },
              category: {
                type: 'string',
                enum: ['critical-bug', 'bug', 'perf', 'feature', 'refactor', 'cleanup'],
              },
              reason: { type: 'string' },
            },
            required: ['number', 'title', 'priority', 'category', 'reason'],
          },
        },
      },
      required: ['items'],
    };

    const result = await this.execute<{ items: PrioritizedIssue[] }>({
      prompt,
      jsonSchema,
      timeoutMs: config.ccQueryPrioritizeTimeoutMs,
    });

    if (!result.success) {
      return result as unknown as CCQueryResult<PrioritizedIssue[]>;
    }

    const items = result.data?.items;
    if (!Array.isArray(items)) {
      return {
        ...result,
        success: false,
        data: undefined,
        error: 'CC returned unexpected structure: expected { items: [...] }',
      };
    }

    return {
      ...result,
      data: items,
    };
  }

  async estimateComplexity(
    issueTitle: string,
    issueBody: string,
  ): Promise<CCQueryResult<ComplexityEstimate>> {
    const prompt = [
      'You are a senior software engineer estimating the complexity of a GitHub issue.',
      'Analyze the issue and provide a complexity estimate.',
      '',
      `Title: ${issueTitle}`,
      '',
      `Description:`,
      issueBody,
      '',
      'Return a JSON object with: complexity ("low", "medium", or "high"), estimatedHours (number), reason (string), risks (array of strings).',
    ].join('\n');

    const jsonSchema = {
      type: 'object',
      properties: {
        complexity: { type: 'string', enum: ['low', 'medium', 'high'] },
        estimatedHours: { type: 'number' },
        reason: { type: 'string' },
        risks: { type: 'array', items: { type: 'string' } },
      },
      required: ['complexity', 'estimatedHours', 'reason', 'risks'],
    };

    return this.execute<ComplexityEstimate>({ prompt, jsonSchema });
  }

  async suggestAssignmentOrder(
    issues: IssueSummary[],
    constraints: QueueConstraints,
  ): Promise<CCQueryResult<AssignmentPlan>> {
    const issueList = issues
      .map((i) => `#${i.number}: ${i.title} [${i.labels.join(', ')}]`)
      .join('\n');
    const prompt = [
      'You are a project manager planning the assignment order for a team of AI coding agents.',
      `The team can run at most ${constraints.maxConcurrent} agents concurrently.`,
      constraints.preferredOrder
        ? `Preferred ordering strategy: ${constraints.preferredOrder}.`
        : '',
      '',
      'Issues:',
      issueList,
      '',
      'Return a JSON object with:',
      '- order: array of { number, reason } indicating the sequence issues should be assigned',
      '- estimatedTotalHours: total estimated hours for all issues',
    ].join('\n');

    const jsonSchema = {
      type: 'object',
      properties: {
        order: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              number: { type: 'number' },
              reason: { type: 'string' },
            },
            required: ['number', 'reason'],
          },
        },
        estimatedTotalHours: { type: 'number' },
      },
      required: ['order', 'estimatedTotalHours'],
    };

    return this.execute<AssignmentPlan>({ prompt, jsonSchema });
  }
}

#!/usr/bin/env node

// Fleet Commander CLI entry point.
//
// When installed globally via npm, `git rev-parse --show-toplevel` will not
// resolve to the package root. This wrapper sets FLEET_COMMANDER_ROOT to the
// package directory before loading the server so that config.ts, db.ts, and
// hook-installer.ts can locate schema.sql, hooks/, scripts/, prompts/, etc.

import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Point FLEET_COMMANDER_ROOT at the package root (one level up from bin/)
if (!process.env['FLEET_COMMANDER_ROOT']) {
  process.env['FLEET_COMMANDER_ROOT'] = path.resolve(__dirname, '..');
}

// Import the server entry point — this starts Fastify and all services.
await import('../dist/server/index.js');

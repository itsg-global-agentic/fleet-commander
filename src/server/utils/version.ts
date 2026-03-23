// =============================================================================
// Fleet Commander — Package Version Utility
// =============================================================================
// Single source of truth for reading the Fleet Commander package version
// from package.json. Cached after first read.
// =============================================================================

import fs from 'fs';
import path from 'path';
import config from '../config.js';

/** Cached version string — read once, reused thereafter */
let _cachedVersion: string | null = null;

/**
 * Read the Fleet Commander version from package.json.
 * Result is cached after the first call.
 *
 * @returns Semantic version string (e.g. "0.0.6"), or "unknown" on failure
 */
export function getPackageVersion(): string {
  if (_cachedVersion) return _cachedVersion;
  try {
    const pkgPath = path.join(config.fleetCommanderRoot, 'package.json');
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
    _cachedVersion = pkg.version ?? 'unknown';
  } catch {
    _cachedVersion = 'unknown';
  }
  return _cachedVersion!;
}

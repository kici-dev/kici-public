/**
 * Config validity diagnostic check.
 *
 * Validates the current orchestrator config against key required fields.
 * Uses a lightweight validation (not the full Zod schema) to avoid
 * importing the entire config module.
 */

import type { DiagnosticDeps, DiagnosticResult } from '../types.js';

/** Required config fields and their descriptions. */
const REQUIRED_FIELDS: Array<{ key: string; label: string }> = [
  { key: 'mode', label: 'Operating mode' },
  { key: 'databaseUrl', label: 'Database URL' },
];

export async function checkConfigValidity(deps: DiagnosticDeps): Promise<DiagnosticResult> {
  const start = Date.now();

  const missing: string[] = [];
  for (const { key, label } of REQUIRED_FIELDS) {
    if (!deps.config[key]) {
      missing.push(label);
    }
  }

  const durationMs = Date.now() - start;

  if (missing.length > 0) {
    return {
      name: 'Config validity',
      status: 'fail',
      message: `Config invalid: missing ${missing.join(', ')}`,
      details: { missingFields: missing },
      durationMs,
    };
  }

  // Check for valid mode values
  const mode = deps.config.mode as string;
  const validModes = ['platform', 'hybrid', 'independent'];
  if (!validModes.includes(mode)) {
    return {
      name: 'Config validity',
      status: 'fail',
      message: `Config invalid: unknown mode "${mode}"`,
      details: { invalidMode: mode, validModes },
      durationMs,
    };
  }

  return {
    name: 'Config validity',
    status: 'pass',
    message: `Config valid (mode: ${mode})`,
    details: { mode },
    durationMs,
  };
}

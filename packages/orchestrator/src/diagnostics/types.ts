/**
 * Diagnostic health check types.
 *
 * Defines the shape of diagnostic results and check functions
 * used by the diagnostic runner and CLI/HTTP interfaces.
 */

import type { Kysely } from 'kysely';
import type { Database } from '../db/types.js';
import type { AgentRegistry } from '../agent/registry.js';
import type { ScalerManager } from '../scaler/manager.js';

/** Result of a single diagnostic check. */
export interface DiagnosticResult {
  /** Human-readable check name (e.g., "Database connectivity"). */
  name: string;
  /** Check outcome: pass, warn, or fail. */
  status: 'pass' | 'warn' | 'fail';
  /** Short description of the result. */
  message: string;
  /** Optional structured details for debugging. */
  details?: Record<string, unknown>;
  /** How long the check took to run in milliseconds. */
  durationMs: number;
}

/** Dependencies available to diagnostic checks. */
export interface DiagnosticDeps {
  /** DB connection (optional -- standalone mode may not have DB). */
  db?: Kysely<Database>;
  /** Platform WS URL (for connectivity check). */
  platformUrl?: string;
  /** Agent registry for checking connected agents. */
  agentRegistry?: AgentRegistry;
  /** Orchestrator config (for config validity check). */
  config: Record<string, unknown>;
  /** TLS cert path (for expiry check). */
  tlsCertPath?: string;
  /** Scaler manager for recent spawn-failure health (optional -- no scaler configured). */
  scalerManager?: ScalerManager;
}

/** A diagnostic check function. May return one result or several (e.g. one per scaler backend). */
export type DiagnosticCheck = (
  deps: DiagnosticDeps,
) => Promise<DiagnosticResult | DiagnosticResult[]>;

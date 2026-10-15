/** Diagnostic result and check shapes, shared by the runner and the CLI/HTTP interfaces. */

import type { Kysely } from 'kysely';
import type { Database } from '../db/types.js';
import type { AgentRegistry } from '../agent/registry.js';
import type { ScalerManager } from '../scaler/manager.js';
import type { ClusterSettingsReader } from '../cluster/cluster-settings-reader.js';

export interface DiagnosticResult {
  /** Human-readable check name (e.g., "Database connectivity"). */
  name: string;
  status: 'pass' | 'warn' | 'fail';
  /** Short description of the result. */
  message: string;
  /** Structured details for debugging. */
  details?: Record<string, unknown>;
  durationMs: number;
}

export interface DiagnosticDeps {
  /** Standalone mode may not have a DB. */
  db?: Kysely<Database>;
  /** Platform WS URL (for the connectivity check). */
  platformUrl?: string;
  agentRegistry?: AgentRegistry;
  /** Orchestrator config (for the config validity check). */
  config: Record<string, unknown>;
  /** TLS cert path (for the expiry check). */
  tlsCertPath?: string;
  /** For recent spawn-failure health; absent when no scaler is configured. */
  scalerManager?: ScalerManager;
  /**
   * When present, a check reads the live `cluster_settings` value rather than only the
   * configured default — so `kici-admin diagnose` reports what the cluster actually does.
   */
  clusterSettings?: ClusterSettingsReader;
}

/** May return one result or several (e.g. one per scaler backend). */
export type DiagnosticCheck = (
  deps: DiagnosticDeps,
) => Promise<DiagnosticResult | DiagnosticResult[]>;

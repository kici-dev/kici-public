/**
 * Environment types for KiCI's deployment environment model.
 *
 * Environments are org-level entities that group secrets, variables,
 * and protection rules for deployment targets (dev, staging, production).
 */
import type { ApproverClause } from '../approval/types.js';

/** Environment entity — org-level deployment target with protection rules. */
export interface Environment {
  id: string;
  orgId: string;
  name: string;
  type: 'fixed' | 'glob';
  globPattern: string | null;
  branchRestrictions: string[];
  triggerTypeFilters: string[];
  repoPatterns: string[];
  concurrencyLimit: number | null;
  concurrencyStrategy: 'queue' | 'cancel-pending';
  concurrencyTimeoutMs: number;
  requiredReviewers: string[] | null;
  waitTimerSeconds: number | null;
  holdExpirySeconds: number;
  /** Minimum trust tier required for CI execution in this environment. */
  minimumTrust?: 'known' | 'trusted';
  /** Whether this environment allows local (no-remote) executions. Default false. */
  allowLocalExecution?: boolean;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
  createdBy: string;
}

/** Scoped secret — individual secret with a scope path for precedence resolution. */
export interface ScopedSecret {
  id: string;
  orgId: string;
  scope: string;
  key: string;
  encryptedValue: string;
  backendType: 'pg' | 'vault';
  keyVersion: number;
  createdAt: string;
  updatedAt: string;
}

/** Binding that maps a scope pattern to an environment. */
export interface EnvironmentBinding {
  id: string;
  orgId: string;
  environmentId: string;
  scopePattern: string;
  /**
   * Host selector this binding applies to (exact / glob / regex, matched
   * against a fan-out child's agentId / hostname / labels). `'**'` matches
   * every host, preserving fleet-wide behaviour for bindings with no host
   * scope.
   */
  hostPattern: string;
  createdAt: string;
}

/** Non-secret key-value config per environment, with optional lock. */
export interface EnvironmentVariable {
  id: string;
  orgId: string;
  environmentId: string;
  key: string;
  value: string;
  locked: boolean;
  createdAt: string;
  updatedAt: string;
}

/** Per-source override for an environment variable. */
export interface EnvironmentSourceOverride {
  id: string;
  orgId: string;
  environmentId: string;
  routingKey: string;
  key: string;
  value: string;
  createdAt: string;
  updatedAt: string;
}

/** Trust tier for contributor-based CI execution gating. */
export type TrustTier = 'trusted' | 'known' | 'unknown';

/** Held run record for protection gate enforcement. */
export interface HeldRun {
  id: string;
  orgId: string;
  runId: string;
  jobId: string;
  environmentId: string;
  holdType: 'reviewer' | 'timer' | 'concurrency' | 'security';
  status: 'pending' | 'approved' | 'rejected' | 'expired';
  reason: string | null;
  approvedBy: string | null;
  createdAt: string;
  expiresAt: string | null;
  resolvedAt: string | null;
}

/** Result from the protection gate pipeline evaluation. */
export interface ProtectionGateResult {
  action: 'pass' | 'reject' | 'hold' | 'queue' | 'wait';
  reason?: string;
  holdUntil?: string;
  holdType?: 'reviewer' | 'timer' | 'concurrency' | 'security';
  /**
   * Approver clauses for a reviewer hold, mapped from the environment's
   * `requiredReviewers`. Each reviewer string maps to a `{ user }` clause
   * (team-named reviewers are a documented follow-up). Empty/undefined means
   * "any approval-capable member".
   */
  clauses?: ApproverClause[];
}

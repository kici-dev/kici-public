/**
 * Context types for KiCI's named-context model.
 *
 * Contexts are org-level entities that group secrets, variables,
 * and protection rules for deployment targets (dev, staging, production).
 */
import { z } from 'zod';
import type { ApproverClause } from '../approval/types.js';
import type { HoldType } from './hold-type.js';
import type { HeldRunStatus } from './held-run-status.js';
import type { ConcurrencyStrategy } from './concurrency-strategy.js';

/** Context entity — org-level deployment target with protection rules. */
export interface Context {
  id: string;
  orgId: string;
  name: string;
  type: 'fixed' | 'glob';
  globPattern: string | null;
  branchRestrictions: string[];
  triggerTypeFilters: string[];
  repoPatterns: string[];
  concurrencyLimit: number | null;
  concurrencyStrategy: ConcurrencyStrategy;
  concurrencyTimeoutMs: number;
  requiredReviewers: string[] | null;
  waitTimerSeconds: number | null;
  holdExpirySeconds: number;
  /** Minimum trust tier required for CI execution in this context. */
  minimumTrust?: 'known' | 'trusted';
  /** Whether this context allows local (no-remote) executions. Default false. */
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

/** Binding that maps a scope pattern to a context. */
export interface ContextBinding {
  id: string;
  orgId: string;
  contextId: string;
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

/** Non-secret key-value config per context, with optional lock. */
export interface ContextVariable {
  id: string;
  orgId: string;
  contextId: string;
  key: string;
  value: string;
  locked: boolean;
  createdAt: string;
  updatedAt: string;
}

/** Per-source override for a context variable. */
export interface ContextSourceOverride {
  id: string;
  orgId: string;
  contextId: string;
  routingKey: string;
  key: string;
  value: string;
  createdAt: string;
  updatedAt: string;
}

/**
 * Trust tier for CI execution gating (single source of truth).
 *
 * `'known'` is legacy vocabulary: the orchestrator's ref-based trust resolution
 * produces only `'trusted'` (a ref in the base repo) and `'unknown'` (a ref
 * from a fork). It still reaches runtime from a stored
 * `execution_runs.trust_tier` row an internal event inherits, and a context can
 * still declare it as its `minimumTrust` floor. It is slated for removal at
 * v1.0.0, after which trust is a two-value vocabulary.
 */
export const TrustTierSchema = z.enum(['trusted', 'known', 'unknown']);
export type TrustTier = z.infer<typeof TrustTierSchema>;

/** Held run record for protection gate enforcement. */
export interface HeldRun {
  id: string;
  orgId: string;
  runId: string;
  jobId: string;
  contextId: string;
  holdType: HoldType;
  status: HeldRunStatus;
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
  holdType?: HoldType;
  /**
   * Approver clauses for a reviewer hold, mapped from the context's
   * `requiredReviewers`. Each reviewer string maps to a `{ user }` clause
   * (team-named reviewers are a documented follow-up). Empty/undefined means
   * "any approval-capable member".
   */
  clauses?: ApproverClause[];
}

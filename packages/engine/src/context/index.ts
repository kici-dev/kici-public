export type {
  Context,
  ContextBinding,
  ContextVariable,
  ContextSourceOverride,
  ScopedSecret,
  HeldRun,
  ProtectionGateResult,
  TrustTier,
} from './types.js';

export { TrustTierSchema } from './types.js';

export { HoldType, normalizePersistedHoldType, persistedHoldTypeSpellings } from './hold-type.js';

export { trustedContributorHoldReason, unknownContributorHoldReason } from './hold-reason.js';

export { HeldRunStatus } from './held-run-status.js';

export {
  WORKFLOW_MODIFICATION_JOB_ID,
  SECURITY_HOLD_JOB_IDS,
  SECURITY_HOLD_JOB_LABELS,
  INSTALL_JOB_ID_PREFIX,
  installGateJobId,
} from './held-run-job-id.js';

export { ConcurrencyStrategy, DEFAULT_CONCURRENCY_STRATEGY } from './concurrency-strategy.js';

export { DEFAULT_HOLD_EXPIRY_SECONDS } from './hold-expiry.js';

export {
  resolveSecretsForContext,
  resolveSecretsWithProvenance,
  matchScopePattern,
  stripScopePrefix,
} from './scope-resolver.js';
export type { ResolvedSecretCandidate } from './scope-resolver.js';

export type { HostFacts } from './host-match.js';

export { mergeOrderedMaps, ContextGateRejectReason } from './multi-context.js';

export {
  validateScopeName,
  assertValidScopeName,
  ScopeNameError,
  SCOPE_SEGMENT_PATTERN,
  SCOPE_NAME_MAX_LENGTH,
} from './scope-name.js';

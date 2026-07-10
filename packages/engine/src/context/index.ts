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

export { resolveSecretsForContext, matchScopePattern, stripScopePrefix } from './scope-resolver.js';

export type { HostFacts } from './host-match.js';

export { mergeOrderedMaps, ContextGateRejectReason } from './multi-context.js';

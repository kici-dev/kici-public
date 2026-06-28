export type {
  Environment,
  EnvironmentBinding,
  EnvironmentVariable,
  EnvironmentSourceOverride,
  ScopedSecret,
  HeldRun,
  ProtectionGateResult,
  TrustTier,
} from './types.js';

export { TrustTierSchema } from './types.js';

export {
  resolveSecretsForEnvironment,
  matchScopePattern,
  stripScopePrefix,
} from './scope-resolver.js';

export type { HostFacts } from './host-match.js';

export { mergeOrderedMaps, EnvGateRejectReason } from './multi-env.js';

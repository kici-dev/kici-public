/**
 * Agent auto-scaler module.
 *
 * Provides pluggable backend-agnostic agent provisioning for the orchestrator.
 * Supports Docker, bare-metal, and Firecracker backends with YAML configuration,
 * label-set matching, and warm pool management.
 */

export type {
  ResourceLimits,
  LabelSetConfig,
  ManagedAgent,
  ScaleResult,
  ValidationResult,
  ScalerBackend,
  ScalerConfig,
  ScalerEntry,
  ScalerEvent,
  ScalerRedispatchTrigger,
  WarmPoolConfig,
  FirecrackerNetworkConfig,
} from './types.js';

export {
  loadScalerConfig,
  scalerFileSchema,
  firecrackerNetworkSchema,
  parseMemoryString,
} from './config.js';

export {
  normalizeLabelSet,
  labelSetsMatch,
  detectLabelSetOverlaps,
  findBackendForLabels,
} from './label-matcher.js';

export { ContainerScalerBackend, detectRuntime } from './container-backend.js';
export type { ContainerScalerBackendOptions, DetectedRuntime } from './container-backend.js';

export { BareMetalScalerBackend } from './bare-metal-backend.js';
export type { BareMetalScalerBackendOptions } from './bare-metal-backend.js';

export { FirecrackerScalerBackend } from './firecracker-backend.js';
export type {
  FirecrackerScalerBackendOptions,
  FirecrackerManagedAgent,
} from './firecracker-backend.js';

export { createScalerBackend, requiredToolsFor } from './backend-factory.js';
export type { BackendFactoryContext, IpAllocatorParams } from './backend-factory.js';

export { EventScalerBackend } from './event-backend.js';
export type { EventScalerBackendOptions, ScalerEventEmitterLike } from './event-backend.js';

export { ClaimStore, DEFAULT_CLAIM_TTL_SECONDS } from './claim-store.js';
export type {
  ClaimSpec,
  ClaimedCredentials,
  ClaimStoreOptions,
  CreateEphemeralToken,
} from './claim-store.js';

export {
  SCALER_EVENT_NAMES,
  ScaleDownReason,
  ScalerScaleUpPayload,
  ScalerScaleDownPayload,
  KICI_EVENT_NAME_PREFIX,
} from './scaler-events.js';

export type { ScalerDestroyContext } from './types.js';

export { FirecrackerApi, FirecrackerApiError } from './firecracker-api.js';

export { ScalerManager } from './manager.js';
export type { ScalerStatus, ScalerManagerDeps } from './manager.js';

export { EventProvisionReaper } from './event-provision-reaper.js';
export type { EventProvisionReaperOptions, ReaperWindows } from './event-provision-reaper.js';

export { WarmPoolManager } from './warm-pool.js';
export type { WarmPoolCallbacks } from './warm-pool.js';

export {
  DbIpAllocator,
  InMemoryIpAllocator,
  parseCidr,
  ipToNumber,
  numberToIp,
  generateMac,
  generateTapName,
} from './ip-allocator.js';
export type {
  IpAllocator,
  IpAllocationResult,
  IpAllocationRecord,
  CidrRange,
} from './ip-allocator.js';

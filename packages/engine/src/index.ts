/**
 * @kici-dev/engine - Consolidated business logic for KiCI.
 *
 * Single source of truth for shared logic used across tiers:
 * - Protocol message schemas (Zod-based, direction-specific unions)
 * - Trigger matching engine (branch, path, event evaluation)
 * - Execution state machine (pure function transitions)
 * - Webhook signature verification (HMAC-SHA256)
 * - WebSocket close codes (unified across all tiers)
 */

// --- Protocol: version, common messages, auth ---
export * from './protocol/version.js';
export * from './protocol/messages/common.js';
export * from './protocol/messages/actor.js';
export * from './protocol/messages/auth.js';
export * from './protocol/messages/capabilities.js';

// --- Protocol: Platform <-> Orchestrator messages ---
// Explicit re-exports to resolve ExecutionEvent name collision with state machine
export {
  webhookRelaySchema,
  webhookRelayStartSchema,
  webhookRelayChunkSchema,
  webhookAckSchema,
  WebhookRelayResult,
  WEBHOOK_RELAY_MAX_BODY_BYTES,
  WEBHOOK_RELAY_CHUNK_SIZE,
  executionEventSchema,
  logChunkSchema,
  peerDiscoverSchema,
  peerUpdateSchema,
  cacheStatsSchema,
  orchMetricsSchema,
  platformToOrchestratorMessageSchema,
  orchestratorToPlatformMessageSchema,
  type WebhookRelay,
  type WebhookRelayStart,
  type WebhookRelayChunk,
  type WebhookAck,
  type LogChunk,
  type PeerDiscover,
  type PeerUpdate,
  type CacheStats,
  type OrchMetrics,
  trustPolicyUpdateSchema,
  type TrustPolicyUpdate,
  staleCheckrunCleanupSchema,
  type StaleCheckrunCleanup,
  type PlatformToOrchestratorMessage,
  type OrchestratorToPlatformMessage,
} from './protocol/messages/platform-orchestrator.js';

// --- Protocol: Execution status (orchestrator -> Platform, in main union) ---
export * from './protocol/messages/execution-status.js';

// --- Protocol: Scaler lifecycle event types (emitted by all scaler backends) ---
export * from './protocol/messages/scaler-event.js';

// --- Protocol: Inbound webhook delivery log (status + payload-omitted enums) ---
export * from './protocol/messages/event-log.js';

// --- Protocol: Access log (read/write attribution; orchestrator access_log table) ---
export * from './protocol/messages/access-log.js';

// --- Approval: shared requirement + clause types (browser-safe, pure Zod) ---
export * from './approval/types.js';

// --- Audit: per-action access-log policy + sampling helper ---
export * from './audit/access-log-policy.js';

// --- Audit: per-action warm-retention policy (cold-store eligibility) ---
export * from './audit/retention-policy.js';

// --- Audit: unified Activity row + filter schemas (federated dashboard view) ---
export * from './audit/activity.js';

// --- Protocol: Log pull (separate union, not in main platform-orchestrator protocol) ---
export * from './protocol/messages/log-pull.js';

// --- Protocol: Dashboard REST-over-WS messages (separate union for dashboard proxy) ---
export * from './protocol/messages/dashboard.js';

// --- Protocol: chunked event-log payload streaming constants ---
export * from './protocol/event-log-payload.js';

// --- Protocol: Browser-Platform WS messages (browser live streaming) ---
export * from './protocol/messages/browser.js';

// --- Protocol: Run events and job context (timeline, summary tab) ---
export * from './protocol/messages/run-events.js';

// --- Protocol: Source registration ---
export {
  sourceRegistrationSchema,
  sourceRegistrationAckSchema,
  sourceDeregisterSchema,
  sourceDeregisterAckSchema,
  SourceSubtype,
  SourceProvider,
  type SourceRegistration,
  type SourceRegistrationAck,
  type SourceDeregister,
  type SourceDeregisterAck,
} from './protocol/messages/source-registration.js';

// --- Protocol: Cluster join (zero-knowledge bootstrap) ---
export * from './protocol/messages/join.js';

// --- Protocol: Peer-to-peer messages (orchestrator cluster) ---
export * from './protocol/messages/peer.js';

// --- Protocol: Orchestrator <-> Agent messages ---
export * from './protocol/messages/orchestrator-agent.js';

// --- Trigger matching ---
export * from './trigger/types.js';
export * from './trigger/trigger-event-type.js';
export * from './trigger/decision-trace.js';
export * from './trigger/matcher.js';

// --- Execution state machine ---
export * from './state-machine/index.js';

// --- Provider interfaces ---
export * from './provider/index.js';

// --- WebSocket types ---
export type { WsLike } from './ws/ws-like.js';

// --- WebSocket close codes ---
export * from './ws/close-codes.js';

// --- WebSocket rate limiting ---
export { WsRateLimiter } from './ws/rate-limiter.js';
export type { RateLimiterConfig, RateLimitResult } from './ws/rate-limiter.js';

// --- Environment allowlist ---
export * from './env/environment-allowlist.js';

// --- Secrets management ---
export * from './secrets/index.js';

// --- Environment model (scoped secrets, env merge, protection gates) ---
export * from './environment/index.js';

// --- Structured auto-labels (kici:os:, kici:arch:, kici:agent:, kici:scaler:, kici:host:, kici:role:) ---
export {
  deriveOsArchLabels,
  hostLabel,
  parseHostLabel,
  HOST_LABEL_PREFIX,
  agentTypeLabel,
  scalerLabel,
  mergeAutoLabels,
  normalizeRunsOn,
  KNOWN_ROLES,
  resolveRoleLabels,
  validateNoReservedLabels,
  scalerAgentLabels,
  isSelfReportedLabel,
  SELF_REPORTED_LABEL_PREFIXES,
} from './labels.js';
export type { NormalizedRunsOn } from './labels.js';
export type { AgentRole } from './labels.js';

// --- Label matchers (glob/regex selectors, browser-safe eval) ---
export {
  LabelMatcher,
  matcherMatches,
  matcherSatisfiedBy,
  partitionMatchers,
  compileRegexMatcher,
} from './labels-match.js';

// --- Scaler types ---
export * from './scaler/scaler-backend-type.js';
export * from './scaler/resource-types.js';

// --- Registration types ---
export * from './registration/registerable-trigger-type.js';

// --- Bundler (shared rolldown config for compiler/agent) ---
export * from './bundler/index.js';

// --- Matrix expansion + suffix formatting (pure, browser-safe) ---
export {
  expandSingleDimension,
  expandMultiDimension,
  expandMatrix,
  applyIncludeExclude,
  type StaticMatrixArray,
  type StaticMatrixObject,
  type MatrixInclude,
  type MatrixExclude,
  type MatrixValues,
} from './matrix/expand.js';
export { formatMatrixSuffix, formatExpandedJobName } from './matrix/format.js';

// --- Fanout materialization (matrix jobs -> N dispatchable children) ---
export * from './fanout/materialize.js';

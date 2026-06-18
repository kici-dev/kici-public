/**
 * Barrel export for execution sandbox types and implementations.
 *
 * Provides clean imports for the job runner:
 *   import { BareMetalSandbox, ContainerSandbox, buildSanitizedEnv } from './sandbox/index.js';
 */

// Types
export type {
  ExecutionSandbox,
  SandboxSetupOptions,
  JobExecutionOptions,
  JobExecutionResult,
  SandboxStepResult,
} from './types.js';
export type {
  RunnerToAgentMessage,
  AgentToRunnerMessage,
  EventEmitRequest,
  EventEmitResponse,
  CacheRequestIpc,
  CacheResponseIpc,
  ProvenanceRequestIpc,
  ProvenanceResponseIpc,
  StepApprovalRequestIpc,
  StepApprovalResolvedIpc,
  JobExecutionRequest,
} from './ipc-protocol.js';

// Utilities
export { buildSanitizedEnv } from './env-sanitizer.js';
// Re-export from engine (single source of truth)
export {
  ALLOWED_SYSTEM_VARS,
  KICI_AGENT_ENV_PREFIX,
  AGENT_REQUIRED_KICI_VARS,
} from '@kici-dev/engine';

// Sandbox implementations
export { BareMetalSandbox } from './bare-metal-sandbox.js';
export { FirecrackerSandbox } from './firecracker-sandbox.js';
export { ContainerSandbox } from './container-sandbox.js';

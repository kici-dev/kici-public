/** Barrel export for execution sandbox types and implementations. */

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
  ArtifactRequestIpc,
  ArtifactResponseIpc,
  StepApprovalRequestIpc,
  StepApprovalResolvedIpc,
  JobExecutionRequest,
} from './ipc-protocol.js';

export { buildSanitizedEnv } from './env-sanitizer.js';
// The engine is the single source of truth.
export {
  ALLOWED_SYSTEM_VARS,
  KICI_AGENT_ENV_PREFIX,
  AGENT_REQUIRED_KICI_VARS,
} from '@kici-dev/engine';

export { BareMetalSandbox } from './bare-metal-sandbox.js';
export { FirecrackerSandbox } from './firecracker-sandbox.js';
export { ContainerSandbox } from './container-sandbox.js';
export { fileCloneSourceBinds } from './fork-runner.js';

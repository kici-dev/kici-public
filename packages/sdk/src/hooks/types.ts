import type { StepContext } from '../context.js';

/** Metadata about the job/workflow outcome, available to hooks. */
export interface OutcomeMetadata {
  status: 'cancelled' | 'success' | 'failed';
  reason?: string;
  failedStep?: string;
  stepOutputs: Record<string, unknown>;
  duration: number;
}

/** Context passed to hook functions: StepContext plus the outcome. */
export type HookContext = StepContext & { outcome: OutcomeMetadata };

/** A hook function. */
export type HookFn = (ctx: HookContext) => Promise<void>;

/** Resolved hook configuration, used internally after normalization. */
export interface HookConfig {
  name: string;
  type: 'onCancel' | 'cleanup' | 'onSuccess' | 'onFailure' | 'beforeStep' | 'afterStep';
  run: HookFn;
  timeout?: number; // ms, default 5 minutes
}

/** Hook input: a bare function, or an object with `run` and an optional timeout. */
export type HookInput = HookFn | { run: HookFn; timeout?: number };

import type { ExecutionMode } from '../config.js';

// Only host-sharing backends can leak declared cleanup between jobs: container
// and firecracker reap their whole tree (and external state) on teardown. An
// in-place run is bare-metal against the operator's real tree, marked by
// config.inPlace rather than its own ExecutionMode, so the controller passes
// 'bare-metal' for both.
const HOST_SHARING_BACKENDS: ReadonlySet<ExecutionMode> = new Set(['bare-metal']);

export type CleanupRerunStatus = 'success' | 'failed' | 'timeout' | 'skipped';

export interface CleanupRerunInput {
  workDir: string;
  backend: ExecutionMode;
  declaresCleanup: boolean;
  timeoutMs: number;
  spawn: (workDir: string, signal: AbortSignal) => Promise<void>;
}

export interface CleanupRerunResult {
  status: CleanupRerunStatus;
  durationMs: number;
}

/**
 * Re-runs a hard-killed job's declared cleanup/onFailure hooks against its
 * preserved workdir in a fresh bounded child. 'skipped' when there is nothing
 * to do (no declared cleanup, wrong backend, non-positive timeout). Never
 * throws: a failure is a status.
 */
export async function runDeclaredCleanupOutOfBand(
  input: CleanupRerunInput,
): Promise<CleanupRerunResult> {
  const started = performance.now();
  const done = (status: CleanupRerunStatus): CleanupRerunResult => ({
    status,
    durationMs: Math.round(performance.now() - started),
  });

  if (!input.declaresCleanup) return done('skipped');
  if (!HOST_SHARING_BACKENDS.has(input.backend)) return done('skipped');
  if (!Number.isFinite(input.timeoutMs) || input.timeoutMs <= 0) return done('skipped');

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), input.timeoutMs);
  try {
    await input.spawn(input.workDir, controller.signal);
    return done('success');
  } catch {
    return done(controller.signal.aborted ? 'timeout' : 'failed');
  } finally {
    clearTimeout(timer);
  }
}

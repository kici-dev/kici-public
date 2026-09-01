import type { ExecutionMode } from '../config.js';

// Only host-sharing backends can leak declared cleanup between jobs. Container
// and firecracker reap their whole tree (and external state) on teardown, so an
// out-of-band re-run there is a no-op. In-place runs use bare-metal execution
// against the operator's real tree; it is represented by config.inPlace, not a
// distinct ExecutionMode value, so the controller passes 'bare-metal' for both.
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
 * Re-run a hard-killed job's declared cleanup/onFailure hooks out-of-band,
 * against its preserved workdir, in a fresh bounded child. Returns 'skipped'
 * when there is nothing to do (no declared cleanup, wrong backend, or a
 * non-positive timeout). Never throws — a failure is reported as a status.
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

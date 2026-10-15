import type { $ as Shell } from 'zx';
import type { GenericInitConfig, CacheSpec } from '@kici-dev/sdk';
import { ExecutionStepStatus, LogStream, TimeoutReason } from '@kici-dev/engine';
import { toErrorMessage } from '@kici-dev/shared';
import type { RunnerToAgentMessage } from '../sandbox/ipc-protocol.js';

/** Used when a spec sets no timeout: 10 minutes. */
const DEFAULT_INIT_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * Thrown when an init command exceeds its wall-clock budget. Its distinct
 * timeout reason makes the phase result and job.complete report a timeout, not
 * a generic failure.
 */
class InitTimeoutError extends Error {
  readonly reason = TimeoutReason.enum.job_timeout;
  constructor(timeoutMs: number) {
    super(`init command exceeded its timeout of ${timeoutMs}ms`);
    this.name = 'InitTimeoutError';
  }
}

/**
 * The imperative cache API bound to `ctx.cache` and used by the declarative
 * job/step cache phase; mirrors `@kici-dev/sdk`'s `CacheApi`. Init restores the
 * spec's paths before the command and saves them after on an exact-key miss.
 */
export interface InitCachePort {
  restore(spec: CacheSpec): Promise<{ hit: boolean; matchedKey?: string }>;
  save(spec: CacheSpec): Promise<void>;
}

/**
 * Env-handoff port: the KICI_ENV / KICI_PATH file contract steps use. The port
 * owns the file lifecycle and the parse; the init phase only sequences the two
 * calls around the command.
 */
export interface InitEnvPort {
  /** Allocate fresh KICI_ENV/KICI_PATH files for this init; the shell's env points at them. */
  beginCapture(): Promise<void>;
  /**
   * Parse the files into an EnvDelta, apply it via `applyEnvDelta`
   * (operator-secret guard, masking, PATH-prepend order), then truncate them.
   */
  applyDelta(): Promise<void>;
}

export interface RunInitPhaseOptions {
  /** Run in order. Empty or undefined is a no-op (ok:true). */
  specs: GenericInitConfig[];
  /**
   * The workflow-runner builds a fresh zx$ shell per init (cwd=clone root,
   * env=process.env, log->IPC) so each spec's `env` overlay and KICI_ENV/KICI_PATH
   * files apply.
   */
  shellFor: (spec: GenericInitConfig, index: number) => typeof Shell;
  /** The step loop's masked sender. */
  sendIpc: (msg: RunnerToAgentMessage) => void;
  /** stepIndex for init:0; subsequent specs use base+1, base+2, … (after user steps + hook indices). */
  stepIndexBase: number;
  /** Used when a spec sets `cache`: restore before, save on a miss after. */
  cache?: InitCachePort;
  /** When set, capture before each init and apply the delta after success. */
  env?: InitEnvPort;
}

export interface RunInitPhaseResult {
  ok: boolean;
  /** Set when ok=false. */
  failedInitIndex?: number;
  /** Set when ok=false. */
  error?: string;
  /** The init exceeded its `timeout`. */
  timedOut?: boolean;
  /** `job_timeout` when `timedOut` is true. */
  reason?: TimeoutReason;
}

/** Stops and fails at the first non-zero exit or timeout. */
export async function runInitPhase(opts: RunInitPhaseOptions): Promise<RunInitPhaseResult> {
  if (!opts.specs || opts.specs.length === 0) return { ok: true };
  for (let i = 0; i < opts.specs.length; i++) {
    const spec = opts.specs[i];
    const stepIndex = opts.stepIndexBase + i;
    const stepType = `init:${i}`;
    const outcome = await runOneInit(spec, i, stepIndex, stepType, opts);
    if (!outcome.ok) {
      return {
        ok: false,
        failedInitIndex: i,
        error: outcome.error,
        ...(outcome.timedOut && { timedOut: true, reason: outcome.reason }),
      };
    }
  }
  return { ok: true };
}

/**
 * Rejects with an {@link InitTimeoutError} when `run` outlasts `timeoutMs`. The
 * AbortController only drives that rejection; it does not reach the command.
 */
function withInitTimeout<T>(run: Promise<T>, timeoutMs: number): Promise<T> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  return Promise.race([
    run,
    new Promise<never>((_, reject) => {
      ac.signal.addEventListener('abort', () => reject(new InitTimeoutError(timeoutMs)));
    }),
  ]).finally(() => clearTimeout(timer));
}

/**
 * Restore an init's cache, treating any failure as a miss. The cache only saves
 * time, so a failed download (a network error, a checksum mismatch) runs the
 * command cold exactly as a miss does, the way the declarative job/step cache
 * phase treats one. A line on the init step says why. A failed download never
 * half-writes the tree: the archive is extracted into a scratch dir first.
 */
async function restoreInitCache(
  spec: CacheSpec,
  cache: InitCachePort,
  stepIndex: number,
  sendIpc: RunInitPhaseOptions['sendIpc'],
): Promise<boolean> {
  try {
    return (await cache.restore(spec)).hit;
  } catch (e) {
    sendIpc({
      type: 'log.line',
      stepIndex,
      stream: LogStream.enum.stderr,
      line: `cache restore failed for key ${spec.key}; running without the cache: ${toErrorMessage(e)}`,
    });
    return false;
  }
}

/**
 * Save an init's cache after its command succeeded. A failed save costs only
 * the next run's cache hit, so it is reported on the init step rather than
 * failing a job whose toolchain is already in place.
 */
async function saveInitCache(
  spec: CacheSpec,
  cache: InitCachePort,
  stepIndex: number,
  sendIpc: RunInitPhaseOptions['sendIpc'],
): Promise<void> {
  try {
    await cache.save(spec);
  } catch (e) {
    sendIpc({
      type: 'log.line',
      stepIndex,
      stream: LogStream.enum.stderr,
      line: `cache save failed for key ${spec.key}; the next run starts without it: ${toErrorMessage(e)}`,
    });
  }
}

async function runOneInit(
  spec: GenericInitConfig,
  index: number,
  stepIndex: number,
  stepType: string,
  opts: RunInitPhaseOptions,
): Promise<{ ok: boolean; error?: string; timedOut?: boolean; reason?: TimeoutReason }> {
  opts.sendIpc({ type: 'step.start', stepIndex, stepName: stepType, step_type: stepType });
  const start = Date.now();
  const shell = spec.shell ?? 'bash';
  try {
    // An exact-key hit skips the save afterward.
    let cacheHit = false;
    if (spec.cache && opts.cache) {
      cacheHit = await restoreInitCache(spec.cache, opts.cache, stepIndex, opts.sendIpc);
    }
    // Before opts.shellFor: the shell reads live process.env at spawn, so an
    // unset KICI_ENV/KICI_PATH is unbound under `set -u`.
    await opts.env?.beginCapture();
    const $ = opts.shellFor(spec, index);
    // The shell's env carries job env, secrets and KICI_ENV/KICI_PATH. On a
    // timeout the init fails with job_timeout before any later step runs.
    const timeoutMs = spec.timeout ?? DEFAULT_INIT_TIMEOUT_MS;
    await withInitTimeout($`${shell} -c ${spec.run}`, timeoutMs);
    if (spec.cache && opts.cache && !cacheHit) {
      await saveInitCache(spec.cache, opts.cache, stepIndex, opts.sendIpc);
    }
    // After the cache save, so this init's env and PATH reach later inits and steps.
    await opts.env?.applyDelta();
    opts.sendIpc({
      type: 'step.complete',
      stepIndex,
      status: ExecutionStepStatus.enum.success,
      durationMs: Date.now() - start,
      step_type: stepType,
    });
    return { ok: true };
  } catch (e) {
    const error = toErrorMessage(e);
    const timedOut = e instanceof InitTimeoutError;
    const exitCode =
      e && typeof e === 'object' && 'exitCode' in e && typeof e.exitCode === 'number'
        ? e.exitCode
        : undefined;
    opts.sendIpc({
      type: 'step.complete',
      stepIndex,
      status: ExecutionStepStatus.enum.failed,
      durationMs: Date.now() - start,
      error: { message: error, ...(exitCode !== undefined && { exitCode }) },
      step_type: stepType,
    });
    return { ok: false, error, ...(timedOut && { timedOut: true, reason: e.reason }) };
  }
}

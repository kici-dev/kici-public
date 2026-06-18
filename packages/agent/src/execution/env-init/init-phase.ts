import type { $ as Shell } from 'zx';
import type { GenericInitConfig, CacheSpec } from '@kici-dev/sdk';
import { ExecutionStepStatus, TimeoutReason } from '@kici-dev/engine';
import { toErrorMessage } from '@kici-dev/shared';
import type { RunnerToAgentMessage } from '../sandbox/ipc-protocol.js';

/** Default init timeout when a spec sets none: 10 minutes. */
const DEFAULT_INIT_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * Marker thrown when an init command exceeds its wall-clock budget. Carries the
 * distinct P3 timeout reason so the phase result + job.complete report a timeout
 * rather than a generic failure.
 */
class InitTimeoutError extends Error {
  readonly reason = TimeoutReason.enum.job_timeout;
  constructor(timeoutMs: number) {
    super(`init command exceeded its timeout of ${timeoutMs}ms`);
    this.name = 'InitTimeoutError';
  }
}

/**
 * Cache engine port (P2). Init reuses the same imperative cache API bound to
 * `ctx.cache` (and used by the declarative job/step cache phase) — restore the
 * spec's paths before the command, save them after on an exact-key miss. The
 * shape mirrors `@kici-dev/sdk`'s `CacheApi` (`restore`/`save`).
 */
export interface InitCachePort {
  restore(spec: CacheSpec): Promise<{ hit: boolean; matchedKey?: string }>;
  save(spec: CacheSpec): Promise<void>;
}

/**
 * Env-handoff port (P1). Mirrors the KICI_ENV / KICI_PATH file contract that
 * steps use: before the command the agent allocates fresh KICI_ENV / KICI_PATH
 * files and points the shell env at them (`beginCapture`); after a successful
 * command it reads + parses those files into an EnvDelta and applies it through
 * `applyEnvDelta` (operator-secret guard + PATH-prepend order), then truncates
 * the files (`applyDelta`). P1 owns the file lifecycle and the parse; the init
 * phase only sequences the two calls around the command.
 */
export interface InitEnvPort {
  /** Allocate fresh KICI_ENV/KICI_PATH files for this init; the shell's env points at them. */
  beginCapture(): Promise<void>;
  /** Read+parse the files, apply via applyEnvDelta (operator-secret guard + masking), then truncate. */
  applyDelta(): Promise<void>;
}

export interface RunInitPhaseOptions {
  /** Init specs to run, in order. Empty / undefined => no-op (ok:true). */
  specs: GenericInitConfig[];
  /**
   * Returns the sandbox shell to run the i-th init command with.
   * The workflow-runner builds a fresh zx$ shell (cwd=clone root, env=process.env,
   * log->IPC) per init so each spec's `env` overlay + KICI_ENV/KICI_PATH files apply.
   */
  shellFor: (spec: GenericInitConfig, index: number) => typeof Shell;
  /** Masked IPC sender (same as the step loop's maskedSend). */
  sendIpc: (msg: RunnerToAgentMessage) => void;
  /** stepIndex for init:0; subsequent specs use base+1, base+2, … (after user steps + hook indices). */
  stepIndexBase: number;
  /** Cache engine (P2). When a spec sets `cache`, restore before / save-on-miss after. */
  cache?: InitCachePort;
  /** Env-handoff port (P1). When set, capture before each init and apply the delta after success. */
  env?: InitEnvPort;
}

export interface RunInitPhaseResult {
  ok: boolean;
  /** Index of the init spec that failed (when ok=false). */
  failedInitIndex?: number;
  /** Failure message (when ok=false). */
  error?: string;
  /** True when the failure was a wall-clock timeout (init exceeded `timeout`). */
  timedOut?: boolean;
  /** Distinct P3 timeout reason (`job_timeout`) when `timedOut` is true. */
  reason?: TimeoutReason;
}

/** Run all init specs in order; stop + fail at the first non-zero / timeout. */
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
 * Run a promise against a wall-clock budget. Aborts via an AbortController on
 * breach (mirroring the step loop) and rejects with an {@link InitTimeoutError}
 * carrying the distinct P3 timeout reason. Resolves with the command's value
 * when it finishes first.
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
    // Restore the cache before the command (P2 reuse: same CacheApi the
    // declarative job/step cache uses). Remember whether the exact key hit so
    // we skip a redundant save afterward.
    let cacheHit = false;
    if (spec.cache && opts.cache) {
      const r = await opts.cache.restore(spec.cache);
      cacheHit = r.hit;
    }
    // Allocate fresh KICI_ENV/KICI_PATH files and point the shell env at them so
    // the command can export env + PATH additions to subsequent steps (P1).
    // This MUST precede building the shell: buildSandboxShell snapshots
    // process.env at construction time, so KICI_ENV/KICI_PATH have to be set
    // before the snapshot or the command sees them as unbound (set -u).
    await opts.env?.beginCapture();
    const $ = opts.shellFor(spec, index);
    // Run the user's command through the job's sandbox shell. The shell's cwd is
    // the clone root and its env carries job env + secrets + KICI_ENV/KICI_PATH.
    // Enforce the per-spec wall-clock budget (falling back to the default): on
    // breach the command is aborted and the init fails with the distinct
    // job_timeout reason, before any subsequent step runs.
    const timeoutMs = spec.timeout ?? DEFAULT_INIT_TIMEOUT_MS;
    await withInitTimeout($`${shell} -c ${spec.run}`, timeoutMs);
    // Save the cache after a successful command, but only on a key miss.
    if (spec.cache && opts.cache && !cacheHit) {
      await opts.cache.save(spec.cache);
    }
    // Apply the captured KICI_ENV/KICI_PATH delta after the command succeeds and
    // after the cache save, so this init's env + PATH reach later inits + steps.
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

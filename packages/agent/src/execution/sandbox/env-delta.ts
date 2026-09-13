/**
 * Shared environment-delta applier.
 *
 * This is the single code path behind the JS API (ctx.setEnv / ctx.addPath) and
 * the shell-side KICI_ENV / KICI_PATH file contract. Routing both through one
 * helper guarantees they share the operator-secret guard and the PATH-prepend
 * ordering. The generic init phase applies its captured delta through the same
 * function so the init command and a step export env identically.
 */

/** A parsed environment delta to apply to process.env. */
export interface EnvDelta {
  /** KEY -> value pairs to set (last-write-wins). */
  env: Record<string, string>;
  /** Directories to prepend to PATH, in order (first entry ends up first on PATH). */
  pathPrepends: string[];
}

/** Outcome of applying a delta -- used for logging / tests. */
export interface ApplyEnvDeltaResult {
  /** Keys that were applied to the target env. */
  appliedKeys: string[];
  /** Keys that were rejected because they collide with an operator secret. */
  rejectedKeys: string[];
  /** Directories prepended to PATH (in the order they ended up on PATH). */
  appliedPaths: string[];
}

/** Options controlling how a delta is applied. */
export interface ApplyEnvDeltaOptions {
  /** Keys that must never be overridden (operator-injected secrets + reserved ctx keys). */
  operatorSecretKeys: Set<string>;
  /** Environment object to mutate. Defaults to process.env. */
  target?: NodeJS.ProcessEnv;
  /** Invoked once per rejected key (e.g. to emit a masked log warning). */
  onReject?: (key: string) => void;
  /** PATH list separator. Defaults to the platform separator (';' on Windows, ':' elsewhere). */
  pathSeparator?: string;
}

/**
 * Apply an environment delta to `target` (defaults to process.env), honoring the
 * operator-secret guard.
 *
 * - env keys present in `operatorSecretKeys` are rejected (never override an
 *   operator secret); `onReject` fires once per rejected key.
 * - pathPrepends are applied so the FIRST array entry ends up FIRST on PATH.
 */
export function applyEnvDelta(delta: EnvDelta, options: ApplyEnvDeltaOptions): ApplyEnvDeltaResult {
  const target = options.target ?? process.env;
  const appliedKeys: string[] = [];
  const rejectedKeys: string[] = [];

  for (const [key, value] of Object.entries(delta.env)) {
    if (options.operatorSecretKeys.has(key)) {
      rejectedKeys.push(key);
      options.onReject?.(key);
      continue;
    }
    target[key] = value;
    appliedKeys.push(key);
  }

  const appliedPaths: string[] = [];
  if (delta.pathPrepends.length > 0) {
    const sep = options.pathSeparator ?? (process.platform === 'win32' ? ';' : ':');
    // Reverse so the first array entry is prepended last and therefore ends up
    // first on PATH: ['/a','/b'] + '/usr/bin' => '/a:/b:/usr/bin' (':' or ';').
    for (const dir of [...delta.pathPrepends].reverse()) {
      target.PATH = target.PATH ? `${dir}${sep}${target.PATH}` : dir;
    }
    appliedPaths.push(...delta.pathPrepends);
  }

  return { appliedKeys, rejectedKeys, appliedPaths };
}

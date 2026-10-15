/**
 * The one code path behind ctx.setEnv / ctx.addPath, the KICI_ENV / KICI_PATH
 * file contract and the generic init phase's captured delta, so all share the
 * operator-secret guard and the PATH-prepend ordering.
 */

export interface EnvDelta {
  /** Last write wins. */
  env: Record<string, string>;
  /** The first entry ends up first on PATH. */
  pathPrepends: string[];
}

export interface ApplyEnvDeltaResult {
  appliedKeys: string[];
  /** Keys colliding with an operator secret. */
  rejectedKeys: string[];
  /** In the order they ended up on PATH. */
  appliedPaths: string[];
}

export interface ApplyEnvDeltaOptions {
  /** Never overridden: operator-injected secrets + reserved ctx keys. */
  operatorSecretKeys: Set<string>;
  /** Defaults to process.env. */
  target?: NodeJS.ProcessEnv;
  /** Invoked once per rejected key (e.g. to emit a masked log warning). */
  onReject?: (key: string) => void;
  /** Defaults to ';' on Windows, ':' elsewhere. */
  pathSeparator?: string;
}

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
    // Prepended last, the first entry ends up first: ['/a','/b'] => '/a:/b:/usr/bin'.
    for (const dir of [...delta.pathPrepends].reverse()) {
      target.PATH = target.PATH ? `${dir}${sep}${target.PATH}` : dir;
    }
    appliedPaths.push(...delta.pathPrepends);
  }

  return { appliedKeys, rejectedKeys, appliedPaths };
}

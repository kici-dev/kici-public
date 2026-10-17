/**
 * Environment of one init command: the job environment with the init spec's
 * `env` laid over it. A spec key wins over the job's value, except for keys
 * KiCI owns (`KICI_`, any letter case) and operator secret keys, which keep the
 * job's value. Nothing here mutates `base`; each init command gets its own copy.
 */

/** Prefix of the environment keys KiCI owns. An init spec's `env` never sets one. */
const KICI_RESERVED_ENV_PREFIX = 'KICI_';

/** The composed environment plus the spec keys that were refused, by reason. */
export interface ComposedInitEnv {
  env: NodeJS.ProcessEnv;
  /** Spec keys refused because they start with `KICI_`. */
  reservedKeys: string[];
  /** Spec keys refused because they name an operator secret. */
  secretKeys: string[];
}

/** Build one init command's environment. */
export function composeInitEnv(args: {
  base: NodeJS.ProcessEnv;
  specEnv: Record<string, string> | undefined;
  protectedKeys: ReadonlySet<string>;
  platform?: NodeJS.Platform;
}): ComposedInitEnv {
  const caseInsensitive = (args.platform ?? process.platform) === 'win32';
  const fold = (key: string): string => (caseInsensitive ? key.toUpperCase() : key);
  const protectedFolded = new Set([...args.protectedKeys].map(fold));
  const env: NodeJS.ProcessEnv = { ...args.base };
  const reservedKeys: string[] = [];
  const secretKeys: string[] = [];
  for (const [key, value] of Object.entries(args.specEnv ?? {})) {
    if (key.toUpperCase().startsWith(KICI_RESERVED_ENV_PREFIX)) {
      reservedKeys.push(key);
      continue;
    }
    if (protectedFolded.has(fold(key))) {
      secretKeys.push(key);
      continue;
    }
    // On Windows `Path` and `PATH` name one variable; keep only the spec's spelling.
    for (const existing of Object.keys(env)) {
      if (existing !== key && fold(existing) === fold(key)) delete env[existing];
    }
    env[key] = value;
  }
  return { env, reservedKeys, secretKeys };
}

import { SecretNotFoundError } from './errors.js';

/** Metadata about a resolved secret -- which backend and scope provided it. */
export interface SecretMeta {
  value: string;
  /** Backend name that provided the secret (e.g., 'pg', 'openbao'). */
  backend: string;
  /** Full prefixed scope path (e.g., 'pg:production/db'). */
  scope: string;
}

/** Options for materialising existing secret values as a file inside the per-step tmpdir. */
export interface SecretFileOptions {
  /**
   * Secret keys to concatenate, in order, into the file. Each must resolve via
   * `ctx.secrets.get(key)`; missing keys throw `SecretNotFoundError` (carrying
   * every missing key).
   */
  sources: string[];
  /** Separator between source values. Default: none (values joined back-to-back). */
  divider?: string;
  /** File mode. Default `0o600` (owner read/write only). */
  mode?: number;
  /** Filename inside the per-step tmpdir. Default: a unique `secret-1`, `secret-2`, ... */
  name?: string;
}

/** Result of a `mountFile` / `exposeFile` call. */
export interface MountedFile {
  /** Absolute path to the materialised file inside the per-step tmpdir. */
  path: string;
}

/**
 * Agent-side adapter behind `mountFile` / `exposeFile`, so the SDK has no
 * `node:fs` / `node:os` imports. `kici preview` / `kici run --local` plug in
 * the same shape against `os.tmpdir()`.
 */
export interface StepSecretsFileHost {
  /**
   * Write the content to a file in the per-step tmpdir and return its absolute
   * path. The host owns chmod, masker registration (when applicable) and
   * remembering the file for cleanup.
   */
  writeMountedFile(args: {
    content: string;
    sources: string[];
    mode: number;
    name?: string;
  }): Promise<string>;
  /** Track an `exposeFile` env var so `dispose()` can `delete process.env[envVar]`. */
  trackExposedEnv(envVar: string): void;
}

/**
 * Async accessor for step secrets. Secrets are never injected into environment
 * variables automatically: use get() to read one, expose() to inject it.
 */
export interface StepSecrets {
  /** Retrieve a secret value by key. Rejects with SecretNotFoundError if not found. */
  get(key: string): Promise<string>;
  /** Inject a secret into the step's environment variables. Rejects if key not found. */
  expose(key: string): Promise<void>;
  /** Check if a secret key exists. Synchronous, never throws. */
  has(key: string): boolean;
  /** Retrieve metadata about a resolved secret (backend name and scope). Returns undefined if key not found. */
  getMeta(key: string): SecretMeta | undefined;
  /**
   * Every secret key available to this step, sorted alphabetically. Synchronous,
   * never throws. Names only -- `getMeta(key)` gives backend / scope.
   */
  list(): string[];
  /**
   * Materialise existing secrets as a file in a per-step tmpdir and return its
   * absolute path. The file is removed when the step completes (success,
   * failure, or timeout). Rejects with `SecretNotFoundError` if any source key
   * is missing.
   */
  mountFile(opts: SecretFileOptions): Promise<MountedFile>;
  /**
   * `mountFile(opts)`, then set `process.env[envVar]` to the path. Both are
   * cleaned up when the step completes.
   */
  exposeFile(envVar: string, opts: SecretFileOptions): Promise<MountedFile>;
}

/** StepSecrets that records the key names (never values) accessed via get() or expose(). */
export interface TrackedStepSecrets extends StepSecrets {
  /** Returns sorted array of secret key names accessed via get() or expose(). */
  getAccessLog(): string[];
  /**
   * Sorted key names referenced via `mountFile()` / `exposeFile()`, tracked
   * apart from `get` / `expose` so the orchestrator renders a distinct audit row.
   */
  getMountedKeys(): string[];
  /** Every mount call's audit record, in order; the agent emits them as `step.secret_mount` IPC events. */
  getMountRecords(): readonly StepSecretMountRecord[];
}

/** The IPC event's `kind`, distinguishing a plain mount from a mount with an env var binding. */
export type StepSecretMountKind = 'mountFile' | 'exposeFile';

/** Audit record for one secret-file mount: key names and path / env var, never the content. */
export interface StepSecretMountRecord {
  /** In concatenation order. */
  sources: string[];
  /** Absolute path. */
  target: string;
  /** Env var set when `kind === 'exposeFile'`; otherwise undefined. */
  envVar?: string;
  kind: StepSecretMountKind;
}

/**
 * Result of {@link createStepSecrets}. The agent calls `dispose` from the
 * step-loop `finally` to remove materialised files and clear exposed env vars.
 * `dispose` never throws; failures go to the wiring's `onDisposeError`.
 */
export interface StepSecretsHandle {
  /** Bound into `ctx.secrets`. */
  secrets: TrackedStepSecrets;
  dispose: () => Promise<void>;
}

/**
 * File-mount + cleanup wiring. Without it `mountFile` / `exposeFile` throw:
 * the SDK has no `node:fs` dependency. The agent wires a host; local test mode
 * wires a minimal `os.tmpdir`-backed one.
 */
export interface StepSecretsFileWiring {
  host: StepSecretsFileHost;
  /** Receives `dispose()` errors for logging. */
  onDisposeError?: (err: unknown) => void;
  /** Invoked by `dispose()` (removes the tmpdir, etc.). */
  cleanup: () => Promise<void>;
}

/**
 * Create a StepSecrets backed by a plain secrets map, tracking accessed keys
 * for audit.
 *
 * @param secretsMap - Flat key-value secrets map
 * @param env - Process environment that expose() injects into
 * @param metaMap - The backend and scope each secret key resolved from
 * @param fileWiring - When omitted, `mountFile` and `exposeFile` throw; the
 *   string-only `get` / `expose` / `has` / `list` surface still works.
 */
export function createStepSecrets(
  secretsMap: Record<string, string>,
  env: Record<string, string | undefined>,
  metaMap?: Record<string, SecretMeta>,
  fileWiring?: StepSecretsFileWiring,
): StepSecretsHandle {
  const accessed = new Set<string>();
  const mountedKeys = new Set<string>();
  const mountRecords: StepSecretMountRecord[] = [];

  function assertFileWiring(method: 'mountFile' | 'exposeFile'): StepSecretsFileWiring {
    if (!fileWiring) {
      throw new Error(
        `ctx.secrets.${method}() requires a file-mount host. The current secrets ` +
          `runtime did not wire one in (e.g. you may be running outside the agent ` +
          `or local-test mode).`,
      );
    }
    return fileWiring;
  }

  async function buildContent(opts: SecretFileOptions): Promise<{
    content: string;
    sources: string[];
  }> {
    const sources = opts.sources;
    if (!Array.isArray(sources) || sources.length === 0) {
      throw new Error('mountFile(): "sources" must be a non-empty array of secret keys');
    }
    const missing: string[] = [];
    const parts: string[] = [];
    for (const key of sources) {
      if (!(key in secretsMap)) {
        missing.push(key);
        continue;
      }
      parts.push(secretsMap[key]);
    }
    if (missing.length > 0) {
      // One error: `key` is the first missing key; the message lists them all.
      const err = new SecretNotFoundError(missing[0], Object.keys(secretsMap));
      if (missing.length > 1) {
        (err as Error).message =
          `Secrets ${missing.map((k) => `"${k}"`).join(', ')} not found. ` +
          `Available keys: ${Object.keys(secretsMap).join(', ') || '(none)'}.`;
      }
      throw err;
    }
    for (const key of sources) {
      accessed.add(key);
      mountedKeys.add(key);
    }
    const divider = opts.divider ?? '';
    return { content: parts.join(divider), sources: [...sources] };
  }

  const secrets: TrackedStepSecrets = {
    async get(key: string): Promise<string> {
      if (!(key in secretsMap)) {
        throw new SecretNotFoundError(key, Object.keys(secretsMap));
      }
      accessed.add(key);
      return secretsMap[key];
    },

    async expose(key: string): Promise<void> {
      if (!(key in secretsMap)) {
        throw new SecretNotFoundError(key, Object.keys(secretsMap));
      }
      accessed.add(key);
      (env as Record<string, string>)[key] = secretsMap[key];
    },

    has(key: string): boolean {
      return key in secretsMap;
    },

    getMeta(key: string): SecretMeta | undefined {
      if (!metaMap || !(key in metaMap)) return undefined;
      return metaMap[key];
    },

    list(): string[] {
      return Object.keys(secretsMap).sort();
    },

    async mountFile(opts: SecretFileOptions): Promise<MountedFile> {
      const wiring = assertFileWiring('mountFile');
      const { content, sources } = await buildContent(opts);
      const path = await wiring.host.writeMountedFile({
        content,
        sources,
        mode: opts.mode ?? 0o600,
        name: opts.name,
      });
      mountRecords.push({ sources, target: path, kind: 'mountFile' });
      return { path };
    },

    async exposeFile(envVar: string, opts: SecretFileOptions): Promise<MountedFile> {
      if (typeof envVar !== 'string' || envVar.length === 0) {
        throw new Error('exposeFile(): "envVar" must be a non-empty string');
      }
      const wiring = assertFileWiring('exposeFile');
      const { content, sources } = await buildContent(opts);
      const path = await wiring.host.writeMountedFile({
        content,
        sources,
        mode: opts.mode ?? 0o600,
        name: opts.name,
      });
      (env as Record<string, string>)[envVar] = path;
      wiring.host.trackExposedEnv(envVar);
      mountRecords.push({ sources, target: path, envVar, kind: 'exposeFile' });
      return { path };
    },

    getAccessLog(): string[] {
      return [...accessed].sort();
    },

    getMountedKeys(): string[] {
      return [...mountedKeys].sort();
    },

    getMountRecords(): readonly StepSecretMountRecord[] {
      return mountRecords;
    },
  };

  return {
    secrets,
    dispose: async () => {
      if (!fileWiring) return;
      try {
        await fileWiring.cleanup();
      } catch (err) {
        fileWiring.onDisposeError?.(err);
      }
    },
  };
}

import { SecretNotFoundError } from './errors.js';

/**
 * Metadata about a resolved secret -- which backend and scope provided it.
 */
export interface SecretMeta {
  /** The resolved secret value. */
  value: string;
  /** Backend name that provided the secret (e.g., 'pg', 'openbao-stg'). */
  backend: string;
  /** Full prefixed scope path (e.g., 'pg:production/db'). */
  scope: string;
}

/**
 * Options for materialising one or more existing secret values as a file
 * on-disk inside the per-step tmpdir.
 */
export interface SecretFileOptions {
  /**
   * Names of existing secret keys to concatenate (in order) into the file.
   * Each key must resolve via `ctx.secrets.get(key)`; missing keys cause
   * `SecretNotFoundError` to be thrown (carrying every missing key).
   */
  sources: string[];
  /**
   * Optional separator written between concatenated source values.
   * Default: no divider (values are joined back-to-back).
   */
  divider?: string;
  /**
   * File mode to chmod the materialised file to. Default `0o600`
   * (owner read/write only).
   */
  mode?: number;
  /**
   * Optional filename inside the per-step tmpdir. When omitted, the
   * runtime auto-generates a unique name (`secret-1`, `secret-2`, ...).
   */
  name?: string;
}

/**
 * Result of a `mountFile` / `exposeFile` call.
 */
export interface MountedFile {
  /** Absolute path to the materialised file inside the per-step tmpdir. */
  path: string;
}

/**
 * Host-side adapter passed by the agent to back the file-mount API.
 *
 * The SDK owns the public surface (`mountFile` / `exposeFile`) but defers
 * disk and `process.env` operations to the agent so the SDK stays free of
 * any `node:fs` / `node:os` imports. Local-test mode (`kici test`) plugs
 * in the same adapter shape against `os.tmpdir()`.
 */
export interface StepSecretsFileHost {
  /**
   * Materialise the concatenated content to a file inside the per-step
   * tmpdir. The host is responsible for chmod + masker registration
   * (when applicable) and for remembering the file for cleanup.
   * Returns the absolute path on success.
   */
  writeMountedFile(args: {
    content: string;
    sources: string[];
    mode: number;
    name?: string;
  }): Promise<string>;
  /**
   * Track an env var that was set as part of `exposeFile`, so the
   * runtime can `delete process.env[envVar]` during `dispose()`.
   */
  trackExposedEnv(envVar: string): void;
}

/**
 * Async accessor interface for step secrets.
 * Secrets are never automatically injected into environment variables.
 * Use get() to read a secret value, expose() to explicitly inject into env.
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
   * Return every secret key available to this step, sorted alphabetically.
   * Synchronous, never throws. Returns names only -- call `getMeta(key)` to
   * inspect backend / scope for a specific key.
   */
  list(): string[];
  /**
   * Materialise one or more existing secrets as a tmpfile inside a
   * per-step tmpdir. Returns the absolute file path. The file is removed
   * automatically when the step completes (success, failure, or timeout).
   * Rejects with `SecretNotFoundError` if any source key is missing.
   */
  mountFile(opts: SecretFileOptions): Promise<MountedFile>;
  /**
   * Sugar: call `mountFile(opts)`, then set `process.env[envVar]` to the
   * resulting path. The env var is unset and the file is removed when
   * the step completes.
   */
  exposeFile(envVar: string, opts: SecretFileOptions): Promise<MountedFile>;
}

/**
 * Extended StepSecrets with access tracking.
 * Tracks which secret keys were accessed via get() or expose() calls.
 * Only key names are recorded -- never values.
 */
export interface TrackedStepSecrets extends StepSecrets {
  /** Returns sorted array of secret key names accessed via get() or expose(). */
  getAccessLog(): string[];
  /**
   * Returns sorted array of secret key names referenced via `mountFile()` /
   * `exposeFile()`. Mounts are tracked separately from plain `get` / `expose`
   * accesses so the orchestrator can render a distinct audit row.
   */
  getMountedKeys(): string[];
  /**
   * Returns the audit records of every mount call (in order). Used by the
   * agent to emit `step.secret_mount` IPC events. Each record carries
   * `{ sources, target, envVar?, kind }`. `target` is the absolute path the
   * file was materialised to.
   */
  getMountRecords(): readonly StepSecretMountRecord[];
}

/**
 * Kinds of secret-file materialisation operations. Surfaced as the `kind`
 * discriminator on the IPC event so the orchestrator can distinguish a
 * plain mount from a mount-with-env-var binding.
 */
export type StepSecretMountKind = 'mountFile' | 'exposeFile';

/**
 * Audit record for a single secret-file materialisation operation.
 * Never contains the file content -- only the key names and the
 * resulting path / env var.
 */
export interface StepSecretMountRecord {
  /** Source secret keys (in concatenation order). */
  sources: string[];
  /** Absolute path the file was materialised to. */
  target: string;
  /** Env var set when `kind === 'exposeFile'`; otherwise undefined. */
  envVar?: string;
  /** Discriminator between `mountFile` and `exposeFile`. */
  kind: StepSecretMountKind;
}

/**
 * Result of {@link createStepSecrets}: the secrets surface itself plus a
 * `dispose` callback the agent invokes from the step-loop `finally` to
 * remove materialised files and clear any exposed env vars.
 *
 * `dispose` swallows its own errors -- it never throws. Failures are
 * surfaced via the optional `onDisposeError` callback passed when the
 * file-mount host was wired in.
 */
export interface StepSecretsHandle {
  /** The secrets surface bound into `ctx.secrets`. */
  secrets: TrackedStepSecrets;
  /** Tear down any materialised files and unset exposed env vars. */
  dispose: () => Promise<void>;
}

/**
 * Optional wiring for the file-mount + cleanup path. When omitted, calls
 * to `mountFile` / `exposeFile` throw -- the SDK alone cannot mount files
 * (no `node:fs` dependency). Production wires a host implementation in
 * the agent; local test mode wires a minimal `os.tmpdir`-backed host.
 */
export interface StepSecretsFileWiring {
  /** The host adapter (see {@link StepSecretsFileHost}). */
  host: StepSecretsFileHost;
  /** Callback for `dispose()` errors. Receives the error for logging. */
  onDisposeError?: (err: unknown) => void;
  /** Tear down callback invoked by `dispose()` (removes the tmpdir, etc.). */
  cleanup: () => Promise<void>;
}

/**
 * Create a StepSecrets instance backed by a plain secrets map.
 * The env parameter receives exposed secrets via expose().
 * Tracks which secrets are accessed for audit/observability purposes.
 *
 * @param secretsMap - Flat key-value secrets map
 * @param env - Process environment to inject exposed secrets into
 * @param metaMap - Optional metadata map from resolveForJobWithMeta (backend + scope per key)
 * @param fileWiring - Optional file-mount host adapter. When omitted, `mountFile`
 *   and `exposeFile` throw -- callers that don't wire a host can still use the
 *   string-only `get` / `expose` / `has` / `list` surface.
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
      // Throw a single SecretNotFoundError carrying the first missing key in
      // its `key` field plus every available key for a helpful message. When
      // more than one source is missing, include the full list in the
      // message so the workflow author sees them all.
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

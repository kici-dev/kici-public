import { mkdtempSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { $ as zx$ } from 'zx';
import { initZx } from '@kici-dev/core';
import { createTempScope, type TempScope, type TempHandle } from '@kici-dev/core/tmp';
import type { StepContext, Logger, WorkflowInfo, JobInfo } from '../context.js';
import type { StepSecretsFileHost } from '../secrets.js';
import type { EventEmitOptions } from '../events/types.js';
import type { EventDefinition } from '../events/define-event.js';
import { isEventDefinition } from '../events/define-event.js';
import { createStepSecrets } from '../secrets.js';
import { resolveStepOutputs, resolveJobOutputs } from '../outputs.js';

// Initialize zx for cross-platform execution (module-level, runs once on import).
// initZx() mutates the zx global's defaults; those defaults propagate into the
// scoped shell built via zx$({ ... }) below.
initZx();

/** A single recorded `ctx.emit(...)` invocation, for assertion in tests. */
export interface RecordedEmit {
  eventName: string;
  payload?: Record<string, unknown>;
  options?: EventEmitOptions;
}

/**
 * Options for {@link createTestStepContext}. Every field is optional — call it
 * with no arguments for a fully-defaulted context. Convenience seed fields
 * (`repoRoot`, `secrets`) sit alongside direct `StepContext` member overrides
 * (everything else), which are shallow-merged on top of the defaults.
 */
export interface TestStepContextOptions extends Partial<Omit<StepContext, 'secrets' | 'log'>> {
  /** Working directory `ctx.$` is pinned to. Defaults to `process.cwd()`. */
  repoRoot?: string;
  /**
   * Seed secrets for `ctx.secrets`. `flat` keys are global; `contexts` values are
   * flattened into the flat map (last-write-wins), matching the local runner.
   */
  secrets?: { flat?: Record<string, string>; contexts?: Record<string, Record<string, string>> };
  /** Logger override. Defaults to a console-backed logger. */
  log?: Logger;
}

/** Handle returned by {@link createTestStepContext}. */
export interface TestStepContext {
  /** The built step context to pass into your step function. */
  ctx: StepContext;
  /** Every `ctx.emit(...)` call, in order — assert against this in tests. */
  emitCalls: ReadonlyArray<RecordedEmit>;
  /**
   * The job-scoped temp allocator backing `ctx.mktemp`/`ctx.mktempFile`. Call
   * `tempScope.disposeAll()` to drain every still-live temp dir/file manually;
   * `dispose()` also drains it.
   */
  tempScope: TempScope;
  /** Tear down secrets state + the per-context tmpdir + temp scope. Call in `afterEach`. */
  dispose: () => Promise<void>;
}

const DEFAULT_WORKFLOW: WorkflowInfo = { name: 'test-workflow' };
const DEFAULT_JOB: JobInfo = { name: 'test-job', runsOn: 'local' };
const NOOP_DELIVERY_ID = 'local-test-noop';

function createConsoleLogger(): Logger {
  return {
    info: (message, ...args) => console.log(message, ...args),
    warn: (message, ...args) => console.warn(`⚠ ${message}`, ...args),
    error: (message, ...args) => console.error(`✗ ${message}`, ...args),
    debug: (message, ...args) => {
      if (process.env.KICI_DEBUG === 'true') console.debug(`[debug] ${message}`, ...args);
    },
  };
}

/**
 * Wire a real secrets surface backed by an on-demand tmpdir file host.
 *
 * The tmpdir is allocated lazily on first `mountFile`/`exposeFile` so steps that
 * never mount pay nothing, and the `process.on('exit')` cleanup handler is
 * registered lazily too (to avoid Node's MaxListeners warning at scale).
 */
function createTestSecrets(
  mergedFlat: Record<string, string>,
  env: Record<string, string | undefined>,
): { secrets: StepContext['secrets']; dispose: () => Promise<void> } {
  let tmpdirPath: string | null = null;
  const exposedEnvVars = new Set<string>();
  let mountCounter = 0;
  let exitHandlerRegistered = false;
  const onProcessExit = (): void => {
    // Only clear the local `env` override the helper actually wrote to via
    // `exposeFile` — it never writes `process.env`, so deleting from there
    // would silently drop a pre-existing host var of the same name.
    for (const envVar of exposedEnvVars) {
      delete env[envVar];
    }
    exposedEnvVars.clear();
    if (tmpdirPath !== null) {
      try {
        rmSync(tmpdirPath, { recursive: true, force: true });
      } catch {
        // Swallow — exit handlers must not throw.
      }
      tmpdirPath = null;
    }
  };
  const fileHost: StepSecretsFileHost = {
    async writeMountedFile(args) {
      if (tmpdirPath === null) {
        tmpdirPath = mkdtempSync(join(tmpdir(), 'kici-secret-files-'));
      }
      if (!exitHandlerRegistered) {
        process.once('exit', onProcessExit);
        exitHandlerRegistered = true;
      }
      mountCounter += 1;
      const filename = args.name ?? `secret-${mountCounter}`;
      const filePath = join(tmpdirPath, filename);
      writeFileSync(filePath, args.content);
      chmodSync(filePath, args.mode);
      return filePath;
    },
    trackExposedEnv(envVar: string) {
      exposedEnvVars.add(envVar);
    },
  };
  const handle = createStepSecrets(mergedFlat, env, undefined, {
    host: fileHost,
    cleanup: async () => {
      if (exitHandlerRegistered) {
        process.off('exit', onProcessExit);
        exitHandlerRegistered = false;
      }
      onProcessExit();
    },
  });
  return { secrets: handle.secrets, dispose: handle.dispose };
}

/**
 * Sanitize a raw identifier into a valid temp label: lowercase, every
 * non-`[a-z0-9-]` char to `-`, falling back to `'step'` when the result is
 * empty. Applied to both the caller-supplied label and the default step id so
 * `ctx.mktemp(...)` never rejects a friendly-but-irregular label.
 */
function sanitizeTempLabel(raw: string): string {
  const cleaned = raw.toLowerCase().replace(/[^a-z0-9-]/g, '-');
  return cleaned.length > 0 ? cleaned : 'step';
}

interface TestTempScope {
  mktemp: (label?: string) => Promise<TempHandle>;
  mktempFile: (label?: string, opts?: { suffix?: string }) => Promise<TempHandle>;
  scope: TempScope;
  dispose: () => Promise<void>;
}

/**
 * Wire a job-scoped temp allocator for the test step context.
 *
 * `mktemp`/`mktempFile` delegate to a {@link createTempScope} instance and track
 * each allocated root so an exit backstop can reclaim it. The `process.once('exit')`
 * handler is registered lazily on first allocation (to avoid Node's MaxListeners
 * warning at scale) and synchronously removes any still-live temp paths — mirroring
 * the secrets-tmpdir exit cleanup. `dispose()` drains the scope and removes the
 * handler; the scope is exposed for manual drain in tests.
 */
function createTestTempScope(defaultLabel: string): TestTempScope {
  const scope = createTempScope();
  // Roots to remove on exit: the temp dir for a `mktemp`, the holder dir for a
  // `mktempFile` (whose handle path is the file inside it). `force: true` makes
  // reclaiming an already-cleaned path a harmless no-op.
  const liveRoots: string[] = [];
  let exitHandlerRegistered = false;
  const onProcessExit = (): void => {
    for (const root of liveRoots) {
      try {
        rmSync(root, { recursive: true, force: true });
      } catch {
        // Swallow — exit handlers must not throw.
      }
    }
    liveRoots.length = 0;
  };
  const ensureExitHandler = (): void => {
    if (!exitHandlerRegistered) {
      process.once('exit', onProcessExit);
      exitHandlerRegistered = true;
    }
  };
  return {
    async mktemp(label) {
      ensureExitHandler();
      const handle = await scope.mktemp(sanitizeTempLabel(label ?? defaultLabel));
      liveRoots.push(handle.path);
      return handle;
    },
    async mktempFile(label, opts) {
      ensureExitHandler();
      const handle = await scope.mktempFile(sanitizeTempLabel(label ?? defaultLabel), opts);
      liveRoots.push(dirname(handle.path));
      return handle;
    },
    scope,
    async dispose() {
      if (exitHandlerRegistered) {
        process.off('exit', onProcessExit);
        exitHandlerRegistered = false;
      }
      await scope.disposeAll();
      liveRoots.length = 0;
    },
  };
}

/**
 * Build a real {@link StepContext} for unit-testing a step function in vitest.
 *
 * `ctx.$` is real zx pinned to `repoRoot`, `ctx.secrets` is real
 * (`createStepSecrets` seeded from `options.secrets`), and `ctx.emit` records
 * each call on `emitCalls` while returning the local delivery receipt.
 * Orchestrator-backed APIs (`ctx.kici.*`, `ctx.attestProvenance`,
 * `ctx.artifacts.*`) reject, and `ctx.cache` no-ops — override any of them via
 * the options object.
 */
export function createTestStepContext(options: TestStepContextOptions = {}): TestStepContext {
  const { repoRoot = process.cwd(), secrets: seed, log, ...overrides } = options;

  const flat = seed?.flat ?? {};
  const namespaced = seed?.contexts ?? {};
  const mergedFlat: Record<string, string> = { ...flat };
  for (const contextSecrets of Object.values(namespaced)) {
    Object.assign(mergedFlat, contextSecrets);
  }

  const env = (overrides.env ?? { ...process.env }) as Record<string, string | undefined>;

  // `setEnv` / `addPath` mutate the real `process.env` (so spawned `ctx.$`
  // subprocesses see the change), so `dispose()` must restore it to avoid
  // leaking env pollution across tests. Snapshot each key's prior value the
  // first time it is mutated; restore (or delete, if it did not exist before)
  // on dispose.
  const processEnvRestores = new Map<string, string | undefined>();
  const recordProcessEnvOriginal = (key: string): void => {
    if (!processEnvRestores.has(key)) processEnvRestores.set(key, process.env[key]);
  };

  // zx$({...}) returns a Shell<...> (a plain callable), not the proxy type the
  // StepContext expects. The agent path does the same cast.
  const scoped$ = zx$({ cwd: repoRoot }) as unknown as StepContext['$'];

  const { secrets, dispose: disposeSecrets } = createTestSecrets(mergedFlat, env);

  // The test builder has no per-step id, so the default `ctx.mktemp()` label
  // derives from the (possibly-overridden) job name; an empty name sanitizes to
  // 'step'.
  const jobInfo = overrides.job ?? DEFAULT_JOB;
  const temp = createTestTempScope(jobInfo.name);

  const emitCalls: RecordedEmit[] = [];
  // Recorder captures each call; a `defineEvent(...)` definition resolves to its
  // `.name` (matching the agent's `resolveEmitEventName`) so `RecordedEmit.eventName`
  // is always the string name, whichever emit overload the step used. The concrete
  // signature is not directly assignable to the overloaded StepContext['emit'] type,
  // so cast.
  const emit = (async (
    nameOrDefinition: string | EventDefinition,
    payload?: Record<string, unknown>,
    opts?: EventEmitOptions,
  ): Promise<{ deliveryId: string }> => {
    const eventName = isEventDefinition(nameOrDefinition)
      ? nameOrDefinition.name
      : nameOrDefinition;
    emitCalls.push({ eventName, payload, options: opts });
    return { deliveryId: NOOP_DELIVERY_ID };
  }) as StepContext['emit'];

  const defaults: StepContext = {
    $: scoped$,
    log: log ?? createConsoleLogger(),
    signal: overrides.signal ?? new AbortController().signal,
    env,
    setEnv: (key: string, value: string) => {
      env[key] = value;
      recordProcessEnvOriginal(key);
      process.env[key] = value;
    },
    addPath: (dir: string) => {
      const current = env.PATH ?? process.env.PATH ?? '';
      const updated = `${dir}:${current}`;
      env.PATH = updated;
      recordProcessEnvOriginal('PATH');
      process.env.PATH = updated;
    },
    inputs: {},
    dispatchInputs: {},
    workflow: DEFAULT_WORKFLOW,
    job: DEFAULT_JOB,
    isTestRun: false,
    secrets,
    emit,
    outputsOf: <T>(ref: { _tag: 'Step'; name: string } | ((...args: any[]) => any)): T =>
      resolveStepOutputs<T>(ref as any),
    jobOutputs: (ref: { name: string }): Record<string, unknown> => resolveJobOutputs(ref),
    setSecretOutput: () => {
      // No-op — secret outputs require orchestrator infrastructure.
    },
    mktemp: (label?: string) => temp.mktemp(label),
    mktempFile: (label?: string, opts?: { suffix?: string }) => temp.mktempFile(label, opts),
    kici: {
      infrastructure: { list: () => Promise.resolve({ scalers: [], agents: [] }) },
      inventory: {
        query: () => Promise.resolve([]),
        get: () => Promise.resolve(null),
      },
      oidc: {
        token: () =>
          Promise.reject(
            new Error('ctx.kici.oidc.token() is not available in a test step context'),
          ),
      },
      git: {
        github: {
          getToken: () =>
            Promise.reject(
              new Error('ctx.kici.git.github.getToken() is not available in a test step context'),
            ),
        },
      },
      host: {
        requestReboot: () =>
          Promise.reject(
            new Error('ctx.kici.host.requestReboot() is not available in a test step context'),
          ),
      },
      bootstrap: {
        ensureInitRunner: () =>
          Promise.reject(
            new Error(
              'ctx.kici.bootstrap.ensureInitRunner() is not available in a test step context',
            ),
          ),
        preBootSend: () =>
          Promise.reject(
            new Error('ctx.kici.bootstrap.preBootSend() is not available in a test step context'),
          ),
        agentVersionStatus: () =>
          Promise.reject(
            new Error(
              'ctx.kici.bootstrap.agentVersionStatus() is not available in a test step context',
            ),
          ),
        restageAgent: () =>
          Promise.reject(
            new Error('ctx.kici.bootstrap.restageAgent() is not available in a test step context'),
          ),
      },
      scaler: {
        claimAgentCredentials: () =>
          Promise.reject(
            new Error(
              'ctx.kici.scaler.claimAgentCredentials() is not available in a test step context',
            ),
          ),
      },
    },
    cache: {
      restore: async () => ({ hit: false }),
      save: async () => {},
    },
    artifacts: {
      upload: () =>
        Promise.reject(new Error('ctx.artifacts.upload() is not available in a test step context')),
      download: () =>
        Promise.reject(
          new Error('ctx.artifacts.download() is not available in a test step context'),
        ),
    },
    attestProvenance: () =>
      Promise.reject(new Error('ctx.attestProvenance() is not available in a test step context')),
  };

  const ctx: StepContext = { ...defaults, ...overrides, env, $: overrides.$ ?? scoped$ };

  const dispose = async (): Promise<void> => {
    await disposeSecrets();
    await temp.dispose();
    for (const [key, original] of processEnvRestores) {
      if (original === undefined) delete process.env[key];
      else process.env[key] = original;
    }
    processEnvRestores.clear();
  };

  return { ctx, emitCalls, tempScope: temp.scope, dispose };
}

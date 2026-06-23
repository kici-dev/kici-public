import { mkdtempSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { $ as zx$ } from 'zx';
import type {
  StepContext,
  Logger,
  WorkflowInfo,
  JobInfo,
  MatrixValues,
  StepSecretsFileHost,
} from '@kici-dev/sdk';
import { createStepSecrets, resolveStepOutputs, resolveJobOutputs } from '@kici-dev/sdk';
import { initZx } from '@kici-dev/core';
import { formatter } from './output-formatter.js';

// Initialize zx for cross-platform execution (module-level, runs once on import).
// initZx() mutates the zx global's defaults (verbose / prefix / etc.); those
// defaults propagate into scoped shells built via zx$({ ... }) below.
initZx();

/**
 * Create a logger that prefixes output with job name.
 */
function createTestLogger(jobName: string): Logger {
  return {
    info: (message: string, ...args: unknown[]) => {
      const formatted = args.length > 0 ? `${message} ${args.join(' ')}` : message;
      formatter.logJobLine(jobName, formatted);
    },
    warn: (message: string, ...args: unknown[]) => {
      const formatted = args.length > 0 ? `${message} ${args.join(' ')}` : message;
      formatter.logJobLine(jobName, `⚠ ${formatted}`);
    },
    error: (message: string, ...args: unknown[]) => {
      const formatted = args.length > 0 ? `${message} ${args.join(' ')}` : message;
      formatter.logJobLine(jobName, `✗ ${formatted}`);
    },
    debug: (message: string, ...args: unknown[]) => {
      // Only log debug if --debug flag is set (checked via KICI_DEBUG env var)
      if (process.env.KICI_DEBUG === 'true') {
        const formatted = args.length > 0 ? `${message} ${args.join(' ')}` : message;
        formatter.logJobLine(jobName, `[debug] ${formatted}`);
      }
    },
  };
}

/**
 * Create a step context for local test execution.
 *
 * `repoRoot` pins `ctx.$` to the workflow's repository root so steps running
 * via local-dispatch behave the same as on the agent path (see
 * `packages/agent/src/execution/sandbox/workflow-runner.ts`). Without this,
 * `ctx.$` would inherit `process.cwd()` — i.e. wherever the user invoked
 * `kici` — which silently breaks any step that uses relative paths.
 */
export function createStepContext(
  workflowInfo: WorkflowInfo,
  jobInfo: JobInfo,
  repoRoot: string,
  inputs: Record<string, unknown> = {},
  matrix?: MatrixValues,
  testSecrets?: { flat: Record<string, string>; contexts: Record<string, Record<string, string>> },
  environment?: string,
  rawPayload?: Record<string, unknown>,
  provider?: string,
): StepContext {
  const flat = testSecrets?.flat ?? {};
  const namespacedSecrets = testSecrets?.contexts ?? {};

  // Auto-flatten context secrets into flat (same merge logic as workflow-runner)
  const mergedFlat: Record<string, string> = { ...flat };
  for (const contextSecrets of Object.values(namespacedSecrets)) {
    Object.assign(mergedFlat, contextSecrets);
  }

  const env = { ...process.env } as Record<string, string | undefined>;

  // zx$({...}) returns a Shell<...> (a plain callable), not the proxy type the
  // StepContext expects. The agent path does the same cast (see
  // `packages/agent/src/execution/sandbox/workflow-runner.ts`).
  const scoped$ = zx$({ cwd: repoRoot }) as unknown as typeof zx$;

  // Per-step tmpdir for ctx.secrets.mountFile / exposeFile. Allocated lazily on
  // first use so steps that never mount pay nothing. The accompanying cleanup
  // closure is wired into createStepSecrets() and runs from the test runner's
  // step-completion path (see `runStepWithSecretsDispose` callers below if any
  // are added; for now the test runner does not call dispose -- callers
  // creating contexts via this factory should call `secretsHandle.dispose()`
  // themselves when the step ends).
  let tmpdirPath: string | null = null;
  const exposedEnvVars = new Set<string>();
  let mountCounter = 0;
  // Auto-cleanup on process exit so the test runner doesn't leak tmpdirs.
  // Production agent path wires explicit per-step `dispose()` via the
  // step-loop's finally; the test runner re-uses one context per job, so
  // the cleanest hook is `process.on('exit')` here. Best-effort -- rmSync
  // with `{ force: true }` cannot throw on a missing path. The handler is
  // registered LAZILY (on first mount) so jobs that never mount don't add
  // an exit listener (each job calls createStepContext; without the lazy
  // guard the test runner would trip Node's MaxListeners warning at scale).
  let exitHandlerRegistered = false;
  const onProcessExit = (): void => {
    for (const envVar of exposedEnvVars) {
      delete env[envVar];
      delete process.env[envVar];
    }
    exposedEnvVars.clear();
    if (tmpdirPath !== null) {
      try {
        rmSync(tmpdirPath, { recursive: true, force: true });
      } catch {
        // Swallow -- exit handlers must not throw.
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
  const secretsHandle = createStepSecrets(mergedFlat, env, undefined, {
    host: fileHost,
    cleanup: async () => {
      if (exitHandlerRegistered) {
        process.off('exit', onProcessExit);
        exitHandlerRegistered = false;
      }
      onProcessExit();
    },
  });

  return {
    $: scoped$,
    log: createTestLogger(jobInfo.name),
    env,
    setEnv: (key: string, value: string) => {
      env[key] = value;
      process.env[key] = value;
    },
    addPath: (dir: string) => {
      const current = env.PATH ?? process.env.PATH ?? '';
      const updated = `${dir}:${current}`;
      env.PATH = updated;
      process.env.PATH = updated;
    },
    inputs,
    workflow: workflowInfo,
    job: jobInfo,
    matrix,
    isTestRun: false,
    environment,
    ...(rawPayload && { rawPayload }),
    ...(provider && { provider }),
    secrets: secretsHandle.secrets,
    emit: async () => {
      // No-op in local test runner -- events are not routed locally
      return { deliveryId: 'local-test-noop' };
    },
    outputsOf: <T>(ref: { _tag: 'Step'; name: string } | ((...args: any[]) => any)): T => {
      return resolveStepOutputs<T>(ref as any);
    },
    jobOutputs: (ref: { name: string }): Record<string, unknown> => {
      return resolveJobOutputs(ref);
    },
    setSecretOutput: () => {
      // No-op in local test runner -- secret outputs require orchestrator infrastructure
    },
    kici: {
      infrastructure: {
        list: () => Promise.resolve({ scalers: [], agents: [] }),
      },
      inventory: {
        // The host roster is orchestrator-cluster state; the local test runner
        // has no cluster, so it reports an empty roster.
        query: () => Promise.resolve([]),
        get: () => Promise.resolve(null),
      },
      oidc: {
        // OIDC ID tokens require the orchestrator->Platform mint relay, which
        // is not available in the local test runner.
        token: () =>
          Promise.reject(
            new Error('ctx.kici.oidc.token() is not available in the local test runner'),
          ),
      },
    },
    cache: {
      // No-op in local test runner -- the user-facing cache requires
      // orchestrator object-storage infrastructure not available locally.
      restore: async () => ({ hit: false }),
      save: async () => {},
    },
    // Provenance attestation requires the orchestrator->Platform mint relay and
    // object storage, neither of which is available in the local test runner.
    attestProvenance: () =>
      Promise.reject(new Error('ctx.attestProvenance() is not available in the local test runner')),
  };
}

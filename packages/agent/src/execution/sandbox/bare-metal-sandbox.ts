/**
 * Bare-metal execution sandbox.
 *
 * Uses child_process.fork() with sanitized environment and optional bubblewrap
 * (bwrap) namespace isolation. The workflow runner runs as a separate Node.js
 * process with only explicitly allowed environment variables.
 *
 * Security model:
 * - Environment sanitization: only ALLOWED_SYSTEM_VARS + user env + secrets
 * - Optional bwrap: PID/IPC namespace isolation, read-only system mounts
 * - Network isolation via --unshare-net when bwrap is enabled (loopback only)
 *
 * Without bwrap (sandbox=false), the runner process has full filesystem and
 * network access. This mode provides credential isolation only and should
 * be used in trusted environments.
 */

import { access } from 'node:fs/promises';
import { createLogger } from '@kici-dev/shared';
import { ExecutionJobStatus } from '@kici-dev/engine';
import type {
  ExecutionSandbox,
  SandboxSetupOptions,
  JobExecutionOptions,
  JobExecutionResult,
} from './types.js';
import { createForkRunner, fileCloneSourceBinds, type ForkRunnerHandle } from './fork-runner.js';

const logger = createLogger({ prefix: 'bare-metal-sandbox' });

/** Configuration options for BareMetalSandbox. */
interface BareMetalSandboxOptions {
  /** Absolute path to the compiled workflow-runner.js entry point. */
  runnerPath: string;
  /** Whether to use bubblewrap (bwrap) for namespace isolation. */
  sandbox: boolean;
  /**
   * Network mode when sandbox=true.
   * - 'isolated' (default): bwrap --unshare-net (loopback only).
   * - 'host': keep the host network namespace so workflows can talk to npm,
   *   git, package registries, etc.
   * Ignored when sandbox=false.
   */
  sandboxNetwork?: 'isolated' | 'host';
  /** Pre-sanitized environment variables (system allowlist + user env). */
  env: Record<string, string>;
  /**
   * When true (and bwrap is off), spawn the runner in its own process group so
   * the between-jobs phase can reap a backgrounded daemon. Default true.
   */
  orphanCleanup?: boolean;
}

/**
 * Bare-metal execution sandbox implementation.
 *
 * Forks the workflow runner as a child process with sanitized environment.
 * Optionally wraps execution in bubblewrap for PID/IPC/filesystem isolation.
 */
export class BareMetalSandbox implements ExecutionSandbox {
  private readonly runnerPath: string;
  private readonly useBwrap: boolean;
  private readonly sandboxNetwork: 'isolated' | 'host';
  private readonly env: Record<string, string>;
  private readonly orphanCleanup: boolean;
  private runner: ForkRunnerHandle | null = null;
  private workDir: string | undefined;
  // The most recent job's execution options, retained so an out-of-band
  // cleanup-only re-run can reuse the same dispatch + orchestrator relays.
  private lastOptions: JobExecutionOptions | null = null;

  constructor(options: BareMetalSandboxOptions) {
    this.runnerPath = options.runnerPath;
    this.useBwrap = options.sandbox;
    this.sandboxNetwork = options.sandboxNetwork ?? 'isolated';
    this.env = options.env;
    this.orphanCleanup = options.orphanCleanup ?? true;
  }

  /**
   * Validate that the runner path exists and bwrap is available (if needed).
   */
  async setup(options: SandboxSetupOptions): Promise<void> {
    this.workDir = options.workDir;
    // Validate runner path exists
    try {
      await access(this.runnerPath);
    } catch {
      throw new Error(`Workflow runner not found at: ${this.runnerPath}`);
    }

    // Validate bwrap binary if sandbox mode enabled
    if (this.useBwrap) {
      try {
        const { execSync } = await import('node:child_process');
        execSync('which bwrap', { stdio: 'ignore' });
        if (this.sandboxNetwork === 'isolated') {
          logger.info('Bubblewrap (bwrap) sandbox enabled with network isolation (--unshare-net)');
        } else {
          logger.info(
            'Bubblewrap (bwrap) sandbox enabled with host network (KICI_SANDBOX_NETWORK=host)',
          );
        }
      } catch {
        throw new Error(
          'Bubblewrap (bwrap) not found. Install bubblewrap or set sandbox=false. ' +
            'On Debian/Ubuntu: apt install bubblewrap',
        );
      }
    } else {
      logger.warn(
        'Bare-metal without sandbox provides limited isolation. ' +
          'Only environment sanitization is active. ' +
          'Enable sandbox=true with bubblewrap for PID/IPC/filesystem namespace isolation.',
      );
    }
  }

  /**
   * Execute a job by forking the workflow runner with sanitized environment.
   */
  async executeJob(options: JobExecutionOptions): Promise<JobExecutionResult> {
    // When bwrap is enabled and the dispatch repo URL is a `file://` clone
    // (used by the internal provider in dev/E2E), expose the source dir
    // read-only inside the sandbox so the workflow runner's `git clone`
    // step can read it. Without this the clone fails inside bwrap with
    // `does not appear to be a git repository`.
    const extraReadOnlyBinds = this.useBwrap ? fileCloneSourceBinds(options.dispatch.repoUrl) : [];
    this.lastOptions = options;

    this.runner = createForkRunner(
      {
        runnerPath: this.runnerPath,
        env: this.env,
        useBwrap: this.useBwrap,
        workDir: this.workDir,
        // Network isolation is opt-out via KICI_SANDBOX_NETWORK=host. When
        // 'isolated' (the default), bwrap creates a network namespace with
        // only loopback — no external connectivity. Workflows that need to
        // talk to npm/git/package registries must opt out via 'host'.
        networkIsolation: this.useBwrap && this.sandboxNetwork === 'isolated',
        extraReadOnlyBinds,
        // Detach into a fresh process group only for the plain (non-bwrap) fork:
        // bwrap already contains the tree via its PID namespace.
        detachProcessGroup: this.orphanCleanup && !this.useBwrap,
      },
      options,
    );

    return this.runner.result;
  }

  /**
   * Abort the running job.
   *
   * Sends abort IPC message, then SIGTERM after 10s, SIGKILL after 15s.
   */
  async abort(): Promise<void> {
    if (this.runner) {
      await this.runner.abort();
    }
  }

  /**
   * Clean up the child process if still running. The handle reference is kept
   * (not nulled) so the between-jobs phase can still read `completionHooksRan` /
   * `declaresCleanup` and reap the process group after teardown — the group
   * survives the single child's death. The next `executeJob` overwrites it.
   */
  async teardown(): Promise<void> {
    if (this.runner) {
      this.runner.kill();
    }
  }

  /** Whether the runner signalled its completion hooks ran. */
  get completionHooksRan(): boolean {
    return this.runner?.completionHooksRan ?? true;
  }

  /** Whether the job declared an onFailure / cleanup hook. */
  get declaresCleanup(): boolean {
    return this.runner?.declaresCleanup ?? false;
  }

  /** Reap the finished job's process group. */
  async reap(): Promise<number> {
    return this.runner?.reap() ?? 0;
  }

  /**
   * Re-run the finished job's declared cleanup / onFailure hooks against the
   * preserved workdir, in a fresh cleanup-only child. Reuses the last job's
   * dispatch + orchestrator relays but suppresses step/log callbacks (the
   * original job already reported and its log streamers are gone). Rejects when
   * the cleanup-only child fails so the caller can time it out.
   */
  async runCleanupOnly(workDir: string, signal: AbortSignal): Promise<void> {
    const opts = this.lastOptions;
    if (!opts) return;
    const handle = createForkRunner(
      {
        runnerPath: this.runnerPath,
        env: this.env,
        useBwrap: this.useBwrap,
        workDir,
        networkIsolation: this.useBwrap && this.sandboxNetwork === 'isolated',
        cleanupOnly: true,
        // Cap the SIGTERM→SIGKILL grace so a timeout-abort resolves near the
        // caller's timeout rather than up to the default 30s grace later.
        maxGracePeriodMs: 5_000,
      },
      { ...opts, signal, onStepStatus: () => {}, onLogLine: () => {} },
    );
    const result = await handle.result;
    handle.kill();
    // Reject on any non-success terminal status. A caller timeout aborts the
    // child, which resolves 'cancelled' (not 'failed'); throwing here lets the
    // caller's own AbortSignal.aborted check classify it as 'timeout'.
    if (result.status !== ExecutionJobStatus.enum.success) {
      throw new Error(result.error ?? `cleanup-only re-run did not succeed (${result.status})`);
    }
  }
}

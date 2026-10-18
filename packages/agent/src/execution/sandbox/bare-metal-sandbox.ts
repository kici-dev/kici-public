/**
 * Bare-metal execution sandbox: forks the workflow runner as a separate Node.js
 * process with only explicitly allowed env vars, optionally under bubblewrap.
 *
 * Security model:
 * - Environment sanitization: only ALLOWED_SYSTEM_VARS + user env + secrets
 * - Optional bwrap: PID/IPC namespace isolation, read-only system mounts
 * - Network isolation via --unshare-net when bwrap is enabled (loopback only)
 *
 * Without bwrap (sandbox=false) the runner has full filesystem and network
 * access: credential isolation only, for trusted environments.
 */

import { access } from 'node:fs/promises';
import { dirname } from 'node:path';
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

interface BareMetalSandboxOptions {
  /** Absolute path to the compiled workflow-runner.js entry point. */
  runnerPath: string;
  /** Use bubblewrap (bwrap) for namespace isolation. */
  sandbox: boolean;
  /**
   * Ignored when sandbox=false.
   * - 'isolated' (default): bwrap --unshare-net (loopback only).
   * - 'host': keep the host network namespace so workflows can reach npm,
   *   git, package registries, etc.
   */
  sandboxNetwork?: 'isolated' | 'host';
  /** Pre-sanitized (system allowlist + user env). */
  env: Record<string, string>;
  /**
   * When true (and bwrap is off), spawn the runner in its own process group so
   * the between-jobs phase can reap a backgrounded daemon. Default true.
   */
  orphanCleanup?: boolean;
  /**
   * Dedicated user for the runner child (`KICI_RUNNER_USER`). Unset, the child
   * shares the agent's uid and can read the agent process.
   */
  runnerUser?: string;
}

export class BareMetalSandbox implements ExecutionSandbox {
  private readonly runnerPath: string;
  private readonly useBwrap: boolean;
  private readonly sandboxNetwork: 'isolated' | 'host';
  private readonly env: Record<string, string>;
  private readonly orphanCleanup: boolean;
  private readonly runnerUser: string | undefined;
  private runner: ForkRunnerHandle | null = null;
  private workDir: string | undefined;
  // Retained so an out-of-band cleanup-only re-run reuses the dispatch + relays.
  private lastOptions: JobExecutionOptions | null = null;

  constructor(options: BareMetalSandboxOptions) {
    this.runnerPath = options.runnerPath;
    this.useBwrap = options.sandbox;
    this.sandboxNetwork = options.sandboxNetwork ?? 'isolated';
    this.env = options.env;
    this.orphanCleanup = options.orphanCleanup ?? true;
    this.runnerUser = options.runnerUser;
  }

  /** Validates the runner path and, when needed, bwrap availability. */
  async setup(options: SandboxSetupOptions): Promise<void> {
    this.workDir = options.workDir;
    try {
      await access(this.runnerPath);
    } catch {
      throw new Error(`Workflow runner not found at: ${this.runnerPath}`);
    }

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

  async executeJob(options: JobExecutionOptions): Promise<JobExecutionResult> {
    // Under bwrap, a `file://` repo URL (the internal provider clones local
    // repos) needs its source dir bound read-only, or the runner's `git clone`
    // fails with `does not appear to be a git repository`. The git credential
    // directory (helper shim, socket, SSH write keys) lives under the host temp
    // dir, which bwrap's private /tmp hides; a read-only bind still lets git run
    // the shim, connect to the socket and ssh read a key.
    const extraReadOnlyBinds = this.useBwrap
      ? [
          ...fileCloneSourceBinds(options.dispatch.repoUrl),
          ...(options.credentialHelperPath ? [dirname(options.credentialHelperPath)] : []),
        ]
      : [];
    this.lastOptions = options;

    this.runner = createForkRunner(
      {
        runnerPath: this.runnerPath,
        env: this.env,
        useBwrap: this.useBwrap,
        workDir: this.workDir,
        // Opt-out via KICI_SANDBOX_NETWORK=host; 'isolated' (default) is loopback only.
        networkIsolation: this.useBwrap && this.sandboxNetwork === 'isolated',
        extraReadOnlyBinds,
        // Detach into a fresh process group only for the plain (non-bwrap) fork:
        // bwrap already contains the tree via its PID namespace.
        detachProcessGroup: this.orphanCleanup && !this.useBwrap,
        ...(this.runnerUser ? { runnerUser: this.runnerUser } : {}),
      },
      options,
    );

    return this.runner.result;
  }

  /** Sends the abort IPC message and SIGTERM, then SIGKILL after the grace period (30s default). */
  async abort(): Promise<void> {
    if (this.runner) {
      await this.runner.abort();
    }
  }

  /**
   * Kills the child. The handle is kept (not nulled) so the between-jobs phase
   * can still read `completionHooksRan` / `declaresCleanup` and reap the process
   * group, which survives the child's death. The next `executeJob` overwrites it.
   */
  async teardown(): Promise<void> {
    if (this.runner) {
      this.runner.kill();
    }
  }

  get completionHooksRan(): boolean {
    return this.runner?.completionHooksRan ?? true;
  }

  get declaresCleanup(): boolean {
    return this.runner?.declaresCleanup ?? false;
  }

  async reap(): Promise<number> {
    return this.runner?.reap() ?? 0;
  }

  /**
   * Reuses the last job's dispatch + relays but suppresses step/log callbacks:
   * the original job already reported and its log streamers are gone.
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
        ...(this.runnerUser ? { runnerUser: this.runnerUser } : {}),
      },
      { ...opts, signal, onStepStatus: () => {}, onLogLine: () => {} },
    );
    const result = await handle.result;
    handle.kill();
    // Reject on any non-success status: a caller timeout resolves 'cancelled'
    // (not 'failed'), and throwing lets the caller's AbortSignal check classify
    // it as 'timeout'.
    if (result.status !== ExecutionJobStatus.enum.success) {
      throw new Error(result.error ?? `cleanup-only re-run did not succeed (${result.status})`);
    }
  }
}

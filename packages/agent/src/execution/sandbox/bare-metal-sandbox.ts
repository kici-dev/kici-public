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
import type {
  ExecutionSandbox,
  SandboxSetupOptions,
  JobExecutionOptions,
  JobExecutionResult,
} from './types.js';
import { createForkRunner, type ForkRunnerHandle } from './fork-runner.js';

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
  private runner: ForkRunnerHandle | null = null;
  private workDir: string | undefined;

  constructor(options: BareMetalSandboxOptions) {
    this.runnerPath = options.runnerPath;
    this.useBwrap = options.sandbox;
    this.sandboxNetwork = options.sandboxNetwork ?? 'isolated';
    this.env = options.env;
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
    const extraReadOnlyBinds: string[] = [];
    if (this.useBwrap) {
      const repoUrl = options.dispatch.repoUrl;
      if (typeof repoUrl === 'string' && repoUrl.startsWith('file://')) {
        try {
          const url = new URL(repoUrl);
          if (url.pathname) extraReadOnlyBinds.push(url.pathname);
        } catch {
          // Malformed file:// URL: let git clone fail with the real error
          // rather than masking it here.
        }
      }
    }

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
   * Clean up the child process if still running.
   */
  async teardown(): Promise<void> {
    if (this.runner) {
      this.runner.kill();
      this.runner = null;
    }
  }
}

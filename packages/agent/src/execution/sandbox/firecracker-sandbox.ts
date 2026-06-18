/**
 * Firecracker execution sandbox (defense-in-depth).
 *
 * The Firecracker backend already provides VM-level isolation (separate kernel,
 * filesystem, network namespace). This sandbox adds defense-in-depth by running
 * the workflow runner as a child process with sanitized environment inside the VM.
 *
 * This prevents customer workflow code from:
 * - Accessing MMDS metadata (orchestrator URL, agent config)
 * - Reading agent environment variables (KICI_*, DATABASE_URL, etc.)
 * - Interfering with the agent process directly
 *
 * The fork mechanism is identical to BareMetalSandbox (sandbox=false) -- no
 * bwrap needed since the VM itself provides PID/IPC/network/filesystem isolation.
 *
 * VM lifecycle (start/stop) is managed by the Firecracker scaler backend,
 * NOT by this sandbox. The sandbox only manages the child process within the VM.
 */

import type {
  ExecutionSandbox,
  SandboxSetupOptions,
  JobExecutionOptions,
  JobExecutionResult,
} from './types.js';
import { createForkRunner, type ForkRunnerHandle } from './fork-runner.js';

/** Configuration options for FirecrackerSandbox. */
interface FirecrackerSandboxOptions {
  /** Absolute path to the compiled workflow-runner.js inside the VM. */
  runnerPath: string;
  /** Pre-sanitized environment variables (system allowlist + user env). */
  env: Record<string, string>;
}

/**
 * Firecracker execution sandbox implementation.
 *
 * Thin defense-in-depth wrapper that forks the workflow runner with sanitized
 * environment inside a Firecracker VM. The VM provides the real isolation;
 * this sandbox ensures credential separation within the VM.
 */
export class FirecrackerSandbox implements ExecutionSandbox {
  private readonly runnerPath: string;
  private readonly env: Record<string, string>;
  private runner: ForkRunnerHandle | null = null;
  private workDir: string | undefined;

  constructor(options: FirecrackerSandboxOptions) {
    this.runnerPath = options.runnerPath;
    this.env = options.env;
  }

  /**
   * No-op: VM is already running, managed by the Firecracker scaler backend.
   */
  async setup(options: SandboxSetupOptions): Promise<void> {
    // Firecracker VM lifecycle is managed by the scaler backend.
    // By the time the agent starts, the VM is already running.
    this.workDir = options.workDir;
  }

  /**
   * Execute a job by forking the workflow runner with sanitized environment.
   *
   * Identical to BareMetalSandbox (sandbox=false) -- no bwrap needed since
   * the VM itself provides full isolation.
   */
  async executeJob(options: JobExecutionOptions): Promise<JobExecutionResult> {
    this.runner = createForkRunner(
      {
        runnerPath: this.runnerPath,
        env: this.env,
        useBwrap: false, // VM provides isolation, no bwrap needed
        workDir: this.workDir,
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
   * Kill child process if still running.
   *
   * VM lifecycle (shutdown) is managed by the scaler backend, not this sandbox.
   */
  async teardown(): Promise<void> {
    if (this.runner) {
      this.runner.kill();
      this.runner = null;
    }
  }
}

/**
 * Firecracker execution sandbox (defense-in-depth).
 *
 * The VM already isolates kernel, filesystem and network namespace. This
 * sandbox also runs the workflow runner as a child process with a sanitized
 * environment inside the VM, which keeps customer workflow code from:
 * - Accessing MMDS metadata (orchestrator URL, agent config)
 * - Reading agent environment variables (KICI_*, DATABASE_URL, etc.)
 * - Interfering with the agent process directly
 *
 * It forks like BareMetalSandbox (sandbox=false), without bwrap: the VM
 * provides PID/IPC/network/filesystem isolation. The Firecracker scaler
 * backend owns the VM lifecycle; this sandbox owns only the child process.
 */

import type {
  ExecutionSandbox,
  SandboxSetupOptions,
  JobExecutionOptions,
  JobExecutionResult,
} from './types.js';
import { createForkRunner, type ForkRunnerHandle } from './fork-runner.js';

interface FirecrackerSandboxOptions {
  /** Absolute path to the compiled workflow-runner.js inside the VM. */
  runnerPath: string;
  /** Pre-sanitized environment variables (system allowlist + user env). */
  env: Record<string, string>;
}

/** The VM provides the real isolation; this sandbox adds credential separation inside it. */
export class FirecrackerSandbox implements ExecutionSandbox {
  private readonly runnerPath: string;
  private readonly env: Record<string, string>;
  private runner: ForkRunnerHandle | null = null;
  private workDir: string | undefined;

  constructor(options: FirecrackerSandboxOptions) {
    this.runnerPath = options.runnerPath;
    this.env = options.env;
  }

  /** Records workDir only: the scaler backend started the VM before the agent. */
  async setup(options: SandboxSetupOptions): Promise<void> {
    this.workDir = options.workDir;
  }

  async executeJob(options: JobExecutionOptions): Promise<JobExecutionResult> {
    this.runner = createForkRunner(
      {
        runnerPath: this.runnerPath,
        env: this.env,
        useBwrap: false, // the VM provides isolation
        workDir: this.workDir,
      },
      options,
    );

    return this.runner.result;
  }

  /**
   * Sends the abort IPC message and SIGTERM at once, then SIGKILL after the
   * grace period (30s by default).
   */
  async abort(): Promise<void> {
    if (this.runner) {
      await this.runner.abort();
    }
  }

  /** Kills the child if still running; the scaler backend shuts the VM down. */
  async teardown(): Promise<void> {
    if (this.runner) {
      this.runner.kill();
      this.runner = null;
    }
  }
}

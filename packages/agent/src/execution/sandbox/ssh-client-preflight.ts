/**
 * Fail a job that declares an SSH-key git credential before any step runs when
 * no ssh client is on PATH. Without it the key is unusable and git fails at
 * push time, inside the write window, at the end of a build.
 *
 * Runs after the init phase, so a client the job installs there
 * (`init: { apt: { packages: ['openssh-client'] } }`) counts.
 */

import { ExecutionJobStatus } from '@kici-dev/engine';
import { docsUrl, validateRequiredTools } from '@kici-dev/shared';
import type { JobExecutionRequest, RunnerToAgentMessage } from './ipc-protocol.js';

/** Sorted names of the `gitCredentials` entries whose `kind` is `ssh`. */
export function sshCredentialNames(gitCredentials: unknown): string[] {
  if (!gitCredentials || typeof gitCredentials !== 'object') return [];
  return Object.entries(gitCredentials as Record<string, unknown>)
    .filter(([, ref]) => (ref as { kind?: unknown } | null)?.kind === 'ssh')
    .map(([name]) => name)
    .sort();
}

/** Reads `process.env.PATH` when called, never a copy taken before init. */
const sshOnLivePath = (): boolean =>
  validateRequiredTools([{ type: 'path-binary', name: 'ssh', reason: 'ssh git credential' }])
    .length === 0;

/** The job's failure reason, or undefined when the job can use its SSH keys. */
export function sshClientPreflightError(
  names: readonly string[],
  sshOnPath: () => boolean = sshOnLivePath,
): string | undefined {
  if (names.length === 0 || sshOnPath()) return undefined;
  return (
    `This job declares an SSH-key git credential (${names.join(', ')}), but no ssh client ` +
    `is on PATH. Install one before the steps run: add ` +
    `init: { apt: { packages: ['openssh-client'] } } to the job, or run the job on an ` +
    `agent image that includes an ssh client. ` +
    `See ${docsUrl('user/patterns/git-credentials#ssh-keys')}`
  );
}

/**
 * On a missing client: `job.complete{failed}` with `stepResults: []` (no step
 * ran) and `process.exit(1)`, the way a failed init phase ends the job.
 */
export function failJobOnMissingSshClient(args: {
  request: JobExecutionRequest;
  maskedSend: (msg: RunnerToAgentMessage) => void;
  sshOnPath?: () => boolean;
}): void {
  const error = sshClientPreflightError(args.request.sshGitCredentials ?? [], args.sshOnPath);
  if (error === undefined) return;
  args.maskedSend({
    type: 'job.complete',
    status: ExecutionJobStatus.enum.failed,
    stepResults: [],
    error,
  });
  process.exit(1);
}

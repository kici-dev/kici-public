import type { GitGrantRequestIpc } from './ipc-protocol.js';

/**
 * Set `sshCapable` on a grant request from the AGENT's knowledge of the job.
 *
 * The runner is job code's process, so its claim is not trusted: an SSH key is
 * written only when the runner's git can read files on the agent's host, which
 * is true exactly for a host-path job given the credential helper. A container
 * job's runner can claim anything; its git still cannot reach the key.
 */
export function withAgentSshCapability(
  msg: GitGrantRequestIpc,
  runnerReadsHostFiles: boolean,
): GitGrantRequestIpc {
  return { ...msg, sshCapable: msg.sshCapable === true && runnerReadsHostFiles };
}

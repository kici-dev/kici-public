/**
 * Agent-facing host reach: the connection coordinates the agent's SSH helper
 * needs for bootstrap.
 *
 * Deliberately no `sshKeySecret` ref: the orchestrator resolves the scoped
 * secret server-side and hands the agent the private key separately, so the ref
 * never reaches the agent. `sshPort` is the OS-sshd port for bring-up; a
 * pre-boot dropbear port comes per call via `SshExecOpts.port`.
 */
export interface HostReach {
  agentId: string;
  address: string | null;
  sshUser: string | null;
  sshPort: number | null;
}

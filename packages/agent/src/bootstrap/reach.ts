/**
 * Agent-facing host reach metadata: how to SSH to a target for bootstrap.
 *
 * This is the subset the agent's SSH helper needs — the connection
 * coordinates only. It deliberately does NOT carry the `sshKeySecret` ref:
 * the orchestrator resolves the scoped secret server-side and hands the agent
 * the already-resolved private key separately, so the secret ref never reaches
 * the agent. `sshPort` is the OS-sshd port for bring-up; a pre-boot dropbear
 * port is supplied per-call via `SshExecOpts.port`.
 */
export interface HostReach {
  agentId: string;
  address: string | null;
  sshUser: string | null;
  sshPort: number | null;
}

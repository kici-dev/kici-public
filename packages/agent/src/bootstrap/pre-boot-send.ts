/**
 * Agent-side pre-boot input send (dropbear / initramfs unlock). The
 * orchestrator's privileged `kici.preBootSend` handler gates on the
 * `kici:capability:ssh-transport` capability, resolves the input secret (e.g. a
 * LUKS passphrase) and audits; the agent pipes the input to the target's
 * pre-boot SSH endpoint (default dropbear port 2222, forced `cryptroot-unlock`).
 * Success is the send completing, not the SSH exit code; the caller composes a
 * host-alive wait to confirm boot.
 */
import { sshExec, type SshDeps } from './ssh-exec.js';
import type { ApiTransport } from './ensure-init-runner.js';
import type { HostReach } from './reach.js';

interface PreBootMaterial {
  reach: HostReach;
  /** The host's bring-up SSH private key — authenticates to dropbear. */
  privateKey: string;
  input: string;
  port: number;
  command: string;
}

export interface PreBootSendOpts {
  inputSecret: string;
  port?: number;
  command?: string;
}

/** The input plaintext is resolved server-side and never logged. */
export async function preBootSend(
  transport: ApiTransport,
  targetAgentId: string,
  opts: PreBootSendOpts,
  deps: SshDeps = {},
): Promise<void> {
  const material = (await transport('kici.preBootSend', {
    targetAgentId,
    inputSecret: opts.inputSecret,
    ...(opts.port !== undefined ? { port: opts.port } : {}),
    ...(opts.command !== undefined ? { command: opts.command } : {}),
  })) as PreBootMaterial;

  // accept-new: the initramfs host key differs from the OS sshd key. The unlock
  // consumes stdin and drops the session, so a non-zero exit is not a failure.
  await sshExec(
    material.reach,
    material.privateKey,
    material.command,
    { stdin: material.input, port: material.port, hostKeyMode: 'accept-new' },
    deps,
  );
}

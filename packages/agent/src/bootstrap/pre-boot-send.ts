/**
 * Agent-side pre-boot input send (dropbear / initramfs unlock).
 *
 * Runs in the AGENT process. Asks the orchestrator's privileged
 * `kici.preBootSend` handler to gate on the `kici:capability:ssh-transport`
 * capability, resolve the input secret (e.g. a LUKS passphrase), and audit;
 * then pipes the resolved input to the target's pre-boot SSH endpoint
 * (default dropbear port 2222, forced `cryptroot-unlock`). The unlock drops
 * the session as the box boots — success is the send completing, not the SSH
 * exit code; the caller composes a host-alive wait to confirm boot.
 */
import { sshExec, type SshDeps } from './ssh-exec.js';
import type { ApiTransport } from './ensure-init-runner.js';
import type { HostReach } from './reach.js';

/** Material the orchestrator returns for a pre-boot send. */
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

/**
 * Ship a pre-boot input to the target's dropbear/initramfs SSH channel. The
 * input plaintext is resolved server-side and never logged. Resolves once the
 * send completes (the SSH session legitimately drops as the box boots).
 */
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

  // Connect to the dropbear port with the host's bring-up key, accept-new host
  // key (the initramfs host key differs from the OS sshd key), and pipe the
  // resolved input to the forced command. The unlock consumes stdin and drops
  // the session, so a non-zero exit is expected and NOT treated as a failure.
  await sshExec(
    material.reach,
    material.privateKey,
    material.command,
    { stdin: material.input, port: material.port, hostKeyMode: 'accept-new' },
    deps,
  );
}

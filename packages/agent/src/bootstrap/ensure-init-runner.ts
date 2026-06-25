/**
 * Agent-side init-runner bring-up.
 *
 * Runs in the AGENT process (never the workflow sandbox), so the bring-up SSH
 * key and bootstrap token the orchestrator hands back never reach user
 * workflow code. The flow:
 *
 *   1. Call the orchestrator's privileged `kici.ensureInitRunner` handler — it
 *      gates on this agent's `kici:capability:ssh-transport` capability,
 *      resolves the target's reach + SSH key, mints a single-use bootstrap
 *      token, audits, and returns the material (or `{ broughtUp: false }` when
 *      the target already has a live agent).
 *   2. Over SSH (ephemeral key, never on disk): drop a launcher onto the target
 *      that starts `kici-agent` with the bootstrap env (token + agent id +
 *      orchestrator URL + labels), and start it detached.
 *
 * The init-runner then connects → `auth.request` (bootstrap token) →
 * `agent.register` auto-enroll as a temporary `kici:init` agent.
 */
import { sshExec, sshPush, type SshDeps } from './ssh-exec.js';
import type { HostReach } from './reach.js';

/** Material the orchestrator returns for a bring-up (mirrors the handler result). */
interface BringupMaterial {
  broughtUp: boolean;
  reach?: HostReach;
  privateKey?: string;
  bootstrapToken?: string;
  targetAgentId?: string;
  orchestratorUrl?: string;
  labels?: string[];
}

/** Transport that relays an API request to the orchestrator and awaits the result. */
export type ApiTransport = (method: string, params: Record<string, unknown>) => Promise<unknown>;

/** Where the `kici-agent` binary is invoked from on the target's rescue env. */
const DEFAULT_AGENT_COMMAND = 'kici-agent';

/** Remote path for the generated bring-up launcher. */
const LAUNCHER_REMOTE_PATH = '/tmp/kici-init-runner.sh';

export interface EnsureInitRunnerDeps extends SshDeps {
  /**
   * The command used to start the init-runner on the target. Defaults to
   * `kici-agent` (resolved on the target's PATH). Override for a rescue env
   * that stages the binary at a fixed path.
   */
  agentCommand?: string;
}

/**
 * Build the launcher script that starts the init-runner on the target with its
 * bootstrap env. Detached (`setsid … &`) so the SSH session can return while
 * the agent keeps running and dials the orchestrator.
 */
function buildLauncher(
  material: Required<
    Pick<BringupMaterial, 'bootstrapToken' | 'targetAgentId' | 'orchestratorUrl' | 'labels'>
  >,
  agentCommand: string,
): string {
  const env = [
    `KICI_AGENT_TOKEN=${shQuote(material.bootstrapToken)}`,
    `KICI_AGENT_ID=${shQuote(material.targetAgentId)}`,
    `KICI_ORCHESTRATOR_URL=${shQuote(material.orchestratorUrl)}`,
    `KICI_LABELS=${shQuote(material.labels.join(','))}`,
    'KICI_EXECUTION_MODE=bare-metal',
    'KICI_PORT=0',
  ].join(' \\\n  ');
  return [
    '#!/usr/bin/env bash',
    'set -euo pipefail',
    `setsid env ${env} \\`,
    `  ${agentCommand} >/tmp/kici-init-runner.log 2>&1 &`,
    'echo "init-runner started pid=$!"',
  ].join('\n');
}

/** Single-quote a value for safe embedding in the launcher's env assignment. */
function shQuote(v: string): string {
  return `'${v.replace(/'/g, `'\\''`)}'`;
}

/**
 * Bring up a temporary init-runner on `targetAgentId`. Returns `{ broughtUp }`:
 * false when the target already had a live agent (the orchestrator no-op'd),
 * true when this call dropped + started the init-runner.
 */
export async function ensureInitRunner(
  transport: ApiTransport,
  targetAgentId: string,
  deps: EnsureInitRunnerDeps = {},
): Promise<{ broughtUp: boolean }> {
  const material = (await transport('kici.ensureInitRunner', { targetAgentId })) as BringupMaterial;
  if (!material.broughtUp) return { broughtUp: false };

  const { reach, privateKey, bootstrapToken, orchestratorUrl, labels } = material;
  if (!reach || !privateKey || !bootstrapToken || !orchestratorUrl || !labels) {
    throw new Error(`orchestrator returned incomplete bring-up material for ${targetAgentId}`);
  }

  const agentCommand = deps.agentCommand ?? DEFAULT_AGENT_COMMAND;
  const launcher = buildLauncher(
    { bootstrapToken, targetAgentId, orchestratorUrl, labels },
    agentCommand,
  );

  // Ship the launcher (never echo the token/key into argv) and run it.
  await sshPush(reach, privateKey, launcher, LAUNCHER_REMOTE_PATH, {}, deps);
  const run = await sshExec(
    reach,
    privateKey,
    `chmod 0700 ${LAUNCHER_REMOTE_PATH} && ${LAUNCHER_REMOTE_PATH}`,
    {},
    deps,
  );
  if (run.exitCode !== 0) {
    throw new Error(
      `init-runner launch on ${targetAgentId} failed: exit ${run.exitCode}${
        run.stderr ? `\n${run.stderr}` : ''
      }`,
    );
  }
  return { broughtUp: true };
}

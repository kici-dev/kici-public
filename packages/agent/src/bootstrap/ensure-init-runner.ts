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
import { AgentDeliveryMode, type AgentPlatform } from '@kici-dev/shared';
import { sshExec, sshPush, type SshDeps } from './ssh-exec.js';
import type { HostReach } from './reach.js';
import { probeTargetPlatform } from './probe-platform.js';
import { stageAgentPayload, type DeliveryMode } from './stage-agent-payload.js';
import type { AgentPayloadSource } from './payload-source.js';

/** Material the orchestrator returns for a bring-up (mirrors the handler result). */
interface BringupMaterial {
  broughtUp: boolean;
  reach?: HostReach;
  privateKey?: string;
  bootstrapToken?: string;
  targetAgentId?: string;
  orchestratorUrl?: string;
  labels?: string[];
  /** The orchestrator's own version — the self-contained payload version to stage. */
  version?: string;
  /** Per-host delivery mode the orchestrator chose (default `ssh-push`). */
  deliveryMode?: AgentDeliveryMode;
}

/** Shape of the `kici.presignAgentPackage` RPC result. */
interface PresignResult {
  url: string;
  sha256: string | null;
}

/** Transport that relays an API request to the orchestrator and awaits the result. */
export type ApiTransport = (method: string, params: Record<string, unknown>) => Promise<unknown>;

/** Remote path for the generated bring-up launcher. */
const LAUNCHER_REMOTE_PATH = '/tmp/kici-init-runner.sh';

export interface EnsureInitRunnerDeps extends SshDeps {
  /**
   * A fixed command used to start the init-runner on the target — the
   * golden-image escape hatch. When set, payload staging is SKIPPED (the image
   * already ships `kici-agent` + a Node runtime at this path). Leave unset for a
   * stock rescue box: the payload source below is staged instead.
   */
  agentCommand?: string;
  /**
   * The source of the self-contained agent+Node payload staged onto a bare box.
   * When set (and no `agentCommand` override), `ensureInitRunner` probes the
   * target platform, stages the version-keyed payload, and boots it on its
   * vendored Node. Constructed from `KICI_AGENT_PAYLOAD_DIR` at the agent entry.
   */
  payloadSource?: AgentPayloadSource;
  /**
   * Force the delivery mode, overriding the orchestrator's per-host choice.
   * Normally the orchestrator picks the mode (from the host's `s3_reachable`
   * hint) and returns it in the bring-up material; this is a test/escape hatch.
   */
  delivery?: DeliveryMode;
  /** Override the on-box extract dir (default `/opt/kici-init`). */
  extractDir?: string;
  /** Ops-agent-side file-hash boundary, injectable for tests. */
  hashLocalFile?: (filePath: string) => Promise<string>;
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
    // Advertise ONLY the bootstrap-token-authorized labels. Without this the
    // agent auto-derives the default role labels (kici:role:builder /
    // kici:role:init-runner) which the single-use bootstrap token does not
    // authorize, and the orchestrator rejects the register at Gate 1
    // ("labels exceed token-bound scope"). An init-runner is a temporary agent
    // that runs its host's pinned child by agent-id pinning, not by role, so it
    // needs no execution roles.
    'KICI_ROLES=',
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
 * Resolve the command the launcher invokes to start the init-runner.
 *
 * - A `deps.agentCommand` override short-circuits staging (golden image).
 * - Otherwise a payload source is required: probe the target's platform, stage
 *   the version-keyed self-contained payload over SSH, and return the staged
 *   launcher path (which boots the agent on its vendored Node — no system Node).
 * - No override AND no source is a misconfiguration, not a silent Node
 *   assumption — throw a clear error.
 */
async function resolveAgentCommand(
  transport: ApiTransport,
  reach: HostReach,
  privateKey: string,
  material: BringupMaterial,
  deps: EnsureInitRunnerDeps,
): Promise<string> {
  if (deps.agentCommand) return deps.agentCommand;
  if (!material.version) {
    throw new Error(
      `orchestrator returned no version for ${material.targetAgentId} — cannot stage a payload`,
    );
  }
  // Fast-fail before the (SSH round-trip) probe: an ssh-push bring-up with no
  // local payload source is a misconfiguration. s3-direct pulls on the box, so
  // it needs no local source and this guard does not apply.
  const forcedS3Direct =
    deps.delivery?.mode === AgentDeliveryMode.enum['s3-direct'] ||
    material.deliveryMode === AgentDeliveryMode.enum['s3-direct'];
  if (!forcedS3Direct && !deps.payloadSource) {
    throw new Error(
      `no agent payload source configured for bringing up ${material.targetAgentId}: ` +
        'set KICI_AGENT_BINARY_SOURCE (object storage), KICI_AGENT_PAYLOAD_DIR (air-gap), or KICI_AGENT_COMMAND (golden image)',
    );
  }
  const platform = await probeTargetPlatform(reach, privateKey, deps);
  const delivery = await resolveDelivery(transport, material, platform, deps);
  const { launcherPath } = await stageAgentPayload(
    reach,
    privateKey,
    { platform, version: material.version, delivery },
    {
      spawnFn: deps.spawnFn,
      payloadSource: deps.payloadSource,
      extractDir: deps.extractDir,
      hashLocalFile: deps.hashLocalFile,
    },
  );
  return launcherPath;
}

/**
 * Decide how the payload reaches the box. An explicit `deps.delivery` override
 * wins (test/escape hatch); otherwise honor the orchestrator's per-host choice.
 * For `s3-direct` we ask the orchestrator (which knows the probed platform now)
 * to mint a box-routable presigned URL via `kici.presignAgentPackage`; a payload
 * with no sha256 is refused (fail-closed — never extract unverifiable bytes).
 */
async function resolveDelivery(
  transport: ApiTransport,
  material: BringupMaterial,
  platform: AgentPlatform,
  deps: EnsureInitRunnerDeps,
): Promise<DeliveryMode> {
  if (deps.delivery) return deps.delivery;
  if (material.deliveryMode !== AgentDeliveryMode.enum['s3-direct']) return { mode: 'ssh-push' };

  const presigned = (await transport('kici.presignAgentPackage', {
    targetAgentId: material.targetAgentId,
    platform,
  })) as PresignResult;
  if (!presigned?.url) {
    throw new Error(`orchestrator returned no presigned URL for ${material.targetAgentId}`);
  }
  if (!presigned.sha256) {
    throw new Error(
      `refusing s3-direct delivery for ${material.targetAgentId}: no sha256 for the payload (cannot verify on the box)`,
    );
  }
  return { mode: 's3-direct', presignedUrl: presigned.url, sha256: presigned.sha256 };
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

  const agentCommand = await resolveAgentCommand(transport, reach, privateKey, material, deps);
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

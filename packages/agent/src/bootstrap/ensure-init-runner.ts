/**
 * Init-runner bring-up. Runs in the AGENT process, never the workflow sandbox,
 * so the bring-up SSH key and bootstrap token never reach user workflow code.
 *
 *   1. The orchestrator's privileged `kici.ensureInitRunner` handler gates on
 *      this agent's `kici:capability:ssh-transport` capability, resolves the
 *      target's reach + SSH key, mints a single-use bootstrap token, audits, and
 *      returns the material (`{ broughtUp: false }` when the target already has
 *      a live agent).
 *   2. Over SSH (ephemeral key, never on disk), a launcher starts `kici-agent`
 *      detached with the bootstrap env.
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
import { shQuote } from '@kici-dev/core';

/** Mirrors the `kici.ensureInitRunner` handler result. */
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
  /** The orchestrator's per-host choice (default `ssh-push`). */
  deliveryMode?: AgentDeliveryMode;
}

/** The `kici.presignAgentPackage` RPC result. */
interface PresignResult {
  url: string;
  sha256: string | null;
}

export type ApiTransport = (method: string, params: Record<string, unknown>) => Promise<unknown>;

const LAUNCHER_REMOTE_PATH = '/tmp/kici-init-runner.sh';

export interface EnsureInitRunnerDeps extends SshDeps {
  /**
   * Golden-image escape hatch: a fixed start command, which skips
   * payload staging (the image ships `kici-agent` + a Node runtime). Unset for a
   * stock rescue box, which gets the payload source staged.
   */
  agentCommand?: string;
  /**
   * The self-contained agent+Node payload for a bare box: without
   * `agentCommand`, the target platform is probed and the version-keyed payload
   * staged and booted on its vendored Node. Built from `KICI_AGENT_PAYLOAD_DIR`
   * at the agent entry.
   */
  payloadSource?: AgentPayloadSource;
  /**
   * Test/escape hatch overriding the orchestrator's per-host choice (made from
   * the host's `s3_reachable` hint).
   */
  delivery?: DeliveryMode;
  /** Default `/opt/kici-init`. */
  extractDir?: string;
  /** Ops-agent-side file-hash boundary, injectable for tests. */
  hashLocalFile?: (filePath: string) => Promise<string>;
}

/** Detached (`setsid … &`) so the SSH session returns while the agent keeps running. */
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
    // Advertise ONLY the token-authorized labels: auto-derived role labels
    // (kici:role:builder / kici:role:init-runner) fail the register at Gate 1
    // ("labels exceed token-bound scope"). An init-runner runs its host's child
    // by agent-id pinning, not by role, so it needs no execution roles.
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

/**
 * `deps.agentCommand` wins (golden image). Otherwise stages the payload and
 * returns its launcher path, which boots on the vendored Node, never a system
 * Node. No command and no source (outside s3-direct) throws.
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
  // Fail before the SSH-round-trip probe; s3-direct pulls on the box and needs
  // no local source.
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
 * `deps.delivery` wins, else the orchestrator's per-host choice. `s3-direct`
 * gets a box-routable presigned URL for the probed platform from
 * `kici.presignAgentPackage`; one with no sha256 is refused (fail-closed:
 * never extract unverifiable bytes).
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

/** `broughtUp` is false when the target already had a live agent. */
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

  // Pushed as a file so the token/key never appear in argv.
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

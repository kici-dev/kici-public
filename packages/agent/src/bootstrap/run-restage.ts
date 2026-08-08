/**
 * Agent-process driver for the `kici.restageAgent` fleet-upgrade apply.
 *
 * Intercepted in the ops agent (like `ensureInitRunner`): the privileged
 * resolve — capability gate, availability gate, reach + SSH key, restart spec —
 * runs on the orchestrator; this driver performs the SSH transport (probe →
 * stage → swap → restart) so the bring-up key never reaches user workflow code.
 * The re-staged permanent agent reconnects on its own persistent credential, so
 * no token is minted or handled here (no self-update-handoff).
 */
import { AgentDeliveryMode, type AgentPlatform } from '@kici-dev/shared';
import type { HostReach } from './reach.js';
import { probeTargetPlatform } from './probe-platform.js';
import { restageAgent, type RestageDeps } from './restage-agent.js';
import type { DeliveryMode } from './stage-agent-payload.js';

/** Material the orchestrator returns for a `kici.restageAgent` authorization. */
interface RestageMaterial {
  reach: HostReach;
  privateKey: string;
  version: string;
  deliveryMode: AgentDeliveryMode;
  restart: { stop: string; start: string; installDir?: string };
}

/** Shape of the `kici.presignAgentPackage` RPC result. */
interface PresignResult {
  url: string;
  sha256: string | null;
}

/** Transport that relays an API request to the orchestrator and awaits the result. */
export type ApiTransport = (method: string, params: Record<string, unknown>) => Promise<unknown>;

/**
 * Resolve the delivery mode for the re-stage. `ssh-push` needs a local payload
 * source; `s3-direct` asks the orchestrator to mint a box-routable presigned URL
 * (keyed by the now-probed platform) and refuses a payload with no sha256
 * (fail-closed — never extract unverifiable bytes on the box).
 */
async function resolveDelivery(
  transport: ApiTransport,
  targetAgentId: string,
  deliveryMode: AgentDeliveryMode,
  platform: AgentPlatform,
): Promise<DeliveryMode> {
  if (deliveryMode !== AgentDeliveryMode.enum['s3-direct']) return { mode: 'ssh-push' };
  const presigned = (await transport('kici.presignAgentPackage', {
    targetAgentId,
    platform,
  })) as PresignResult;
  if (!presigned?.url) {
    throw new Error(`orchestrator returned no presigned URL for re-staging ${targetAgentId}`);
  }
  if (!presigned.sha256) {
    throw new Error(
      `refusing s3-direct re-stage for ${targetAgentId}: no sha256 for the payload (cannot verify on the box)`,
    );
  }
  return { mode: 's3-direct', presignedUrl: presigned.url, sha256: presigned.sha256 };
}

/**
 * Drive one external-actor re-stage: fetch the material, probe the target
 * platform, resolve delivery, then stage + swap + restart via {@link restageAgent}.
 * Returns `{ restaged: false }` when the host is already on the target version.
 */
export async function runRestage(
  transport: ApiTransport,
  targetAgentId: string,
  deps: RestageDeps,
): Promise<{ restaged: boolean }> {
  const material = (await transport('kici.restageAgent', { targetAgentId })) as RestageMaterial;
  const { reach, privateKey, version, deliveryMode, restart } = material;
  if (!reach || !privateKey || !version || !restart) {
    throw new Error(`orchestrator returned incomplete re-stage material for ${targetAgentId}`);
  }

  const platform = await probeTargetPlatform(reach, privateKey, deps);
  const delivery = await resolveDelivery(transport, targetAgentId, deliveryMode, platform);

  return restageAgent(
    reach,
    privateKey,
    {
      platform,
      version,
      delivery,
      ...(restart.installDir ? { installDir: restart.installDir } : {}),
      restart: { stop: restart.stop, start: restart.start },
    },
    deps,
  );
}

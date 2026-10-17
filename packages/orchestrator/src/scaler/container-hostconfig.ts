/**
 * The `HostConfig` every KiCI agent container is created with.
 *
 * Shared by both agent-container spawners — `ContainerScalerBackend` and the
 * bare-metal backend's container mode — so they cannot diverge into two
 * postures (one silently dropping the operator's resource limits).
 */

import type Docker from 'dockerode';
import type { EffectiveLimits } from './types.js';

/**
 * Maximum processes an agent container may create.
 *
 * High enough that no realistic build reaches it, low enough to bound a fork
 * bomb. Not operator-configurable: a `limits.pids` key is a new surface with
 * its own docs and validation, and nothing yet says the constant is wrong.
 */
export const AGENT_CONTAINER_PIDS_LIMIT = 4096;

/**
 * Group id of `kici-sudo` in the KiCI agent image (`packages/agent/Dockerfile`
 * creates it). `/etc/sudoers.d/kici-sudo` grants that group passwordless sudo.
 * The container scaler adds the group only to the single-job containers it
 * starts from a pool's own image, so root never outlives one job.
 */
export const AGENT_SUDO_GROUP_GID = 1990;

/**
 * Why this container is NOT capability-dropped, though the job containers the
 * agent starts are.
 *
 * Both spawn paths set `KICI_EXECUTION_MODE=bare-metal`, and bare-metal
 * container mode also sets `KICI_JOB_IMAGE_AGENT=1` — so unless the job
 * declares its own image, the workflow's steps run as host processes INSIDE
 * this container. `CapDrop: ['ALL']` here would land on customer build steps:
 * `apt-get` and `dpkg` need CHOWN, DAC_OVERRIDE, FOWNER, SETUID and SETGID,
 * and `no-new-privileges` breaks `sudo` and every setuid binary. With no
 * opt-out, the break would be silent and total for `type: container` scalers.
 *
 * The promised hardening lives one boundary in: the agent applies
 * `CapDrop: ['ALL']`, `no-new-privileges` and a tighter `PidsLimit` to each
 * nested JOB container (`packages/agent/src/execution/sandbox/container-hardening.ts`).
 * That boundary confines customer code; this one hosts it.
 *
 * `PidsLimit` is the exception and stays: a fork-bomb ceiling costs a build
 * nothing at 4096.
 */

export interface AgentContainerHostConfigInput {
  /** Resolved cpu / memory ceiling for this spawn, when the operator set one. */
  limits?: EffectiveLimits;
  /** Volume and path bind mounts. */
  binds?: string[];
  /** Extra `host:ip` entries (e.g. a private registry alias). */
  extraHosts?: string[];
  /** Extra group ids for the container's process (`GroupAdd`). */
  supplementaryGroups?: number[];
}

/**
 * Build the agent container's `HostConfig`.
 *
 * Carries the operator's resource limits, a fork-bomb ceiling, and nothing
 * that would restrict the build steps this container runs — see the note on
 * {@link AGENT_CONTAINER_PIDS_LIMIT}.
 */
export function buildAgentContainerHostConfig(
  input: AgentContainerHostConfigInput,
): Docker.HostConfig {
  const memory = input.limits?.memBytes;
  const cpus = input.limits?.cpus;
  return {
    ...(typeof memory === 'number' && memory > 0 ? { Memory: memory } : {}),
    ...(typeof cpus === 'number' && cpus > 0 ? { NanoCpus: Math.round(cpus * 1e9) } : {}),
    ...(input.binds && input.binds.length > 0 ? { Binds: input.binds } : {}),
    ...(input.extraHosts && input.extraHosts.length > 0 ? { ExtraHosts: input.extraHosts } : {}),
    ...(input.supplementaryGroups && input.supplementaryGroups.length > 0
      ? { GroupAdd: input.supplementaryGroups.map(String) }
      : {}),
    // Never auto-remove: the teardown paths read the exited container's logs to
    // explain why an agent never registered.
    AutoRemove: false,
    PidsLimit: AGENT_CONTAINER_PIDS_LIMIT,
  };
}

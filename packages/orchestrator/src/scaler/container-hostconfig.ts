/**
 * The `HostConfig` every KiCI agent container is created with.
 *
 * Two backends spawn an agent container — `ContainerScalerBackend` and the
 * bare-metal backend's container mode — and they had diverged into two
 * postures for one threat: the first applied resource limits, the second
 * applied none and dropped the limits the operator configured on the floor.
 * One builder is what keeps them from diverging again the next time either is
 * touched.
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
 * Why this container is NOT capability-dropped, though the job containers the
 * agent starts are.
 *
 * Both spawn paths set `KICI_EXECUTION_MODE=bare-metal`, and bare-metal
 * container mode also sets `KICI_JOB_IMAGE_AGENT=1` — so unless the job
 * declares its own image, the workflow's steps run as host processes INSIDE
 * this container. It is a build execution environment, not a supervisor.
 * `CapDrop: ['ALL']` here would therefore land on customer build steps:
 * `apt-get` and `dpkg` need CHOWN, DAC_OVERRIDE, FOWNER, SETUID and SETGID,
 * and `no-new-privileges` breaks `sudo` and every setuid binary. There is no
 * opt-out, so the break would be silent and total for `type: container`
 * scalers.
 *
 * The hardening the operator docs promise already exists, one boundary in:
 * the agent applies `CapDrop: ['ALL']`, `no-new-privileges` and a tighter
 * `PidsLimit` to each nested JOB container
 * (`packages/agent/src/execution/sandbox/container-hardening.ts`). That is the
 * boundary that confines customer code; this one hosts it.
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
    // Never auto-remove: the teardown paths read the exited container's logs to
    // explain why an agent never registered.
    AutoRemove: false,
    PidsLimit: AGENT_CONTAINER_PIDS_LIMIT,
  };
}

/**
 * Resolve a job's container spec into something a runtime can pull with.
 *
 * The lock carries credential REFERENCES (`<context>:<secret-name>`), never
 * material — so somebody has to turn those into an authconfig, and three call
 * sites need the identical answer: the agent's container sandbox, the container
 * scaler backend, and the bare-metal backend in container mode. One resolver
 * keeps them from drifting into three subtly different readings of the same
 * lock field.
 */

import { registryHostFromImageRef } from '@kici-dev/engine/scaler/registry-auth';
import type { LockJob } from '@kici-dev/engine';
import type { ResolvedContainerSpawn } from './types.js';

export type { ResolvedContainerSpawn };

/** The `container` field as the lock carries it. */
type LockContainer = LockJob['container'];

export interface ResolveContainerSpawnDeps {
  /**
   * Resolve a qualified `<context>:<secret-name>` reference, or `undefined`
   * when no such secret exists.
   */
  resolveSecret: (qualifiedRef: string) => Promise<string | undefined>;
}

/**
 * Read one half of a `Sourced<Name>` pair.
 *
 * Mirrors `GitCredentialBroker.sourced` deliberately — same vocabulary, same
 * precedence — with one tightening: setting BOTH halves is an error rather
 * than a silent preference, matching the wire schema's `sourced()` refinement.
 * A workflow that sets both has two different intentions in one field, and
 * quietly honouring one of them is how the wrong credential gets used.
 */
async function sourced(
  bag: Record<string, string | undefined>,
  name: string,
  deps: ResolveContainerSpawnDeps,
  required: boolean,
): Promise<string | undefined> {
  const material = bag[`${name}Value`];
  const qualified = bag[`${name}Secret`];

  if (typeof material === 'string' && typeof qualified === 'string') {
    throw new Error(
      `container registry credential: exactly one of ${name}Secret or ${name}Value may be set`,
    );
  }
  if (typeof material === 'string') return material;
  if (typeof qualified !== 'string') {
    if (!required) return undefined;
    throw new Error(`container registry credential is missing '${name}Secret' (or '${name}Value')`);
  }

  const idx = qualified.indexOf(':');
  if (idx <= 0 || idx >= qualified.length - 1) {
    throw new Error(
      `container registry credential '${name}Secret' must be a qualified ` +
        `<context>:<secret-name> reference (got: ${qualified})`,
    );
  }

  const value = await deps.resolveSecret(qualified);
  if (value === undefined) {
    // Names the reference, never the value — this message reaches run logs.
    throw new Error(`container registry secret '${qualified}' not found`);
  }
  return value;
}

/**
 * Resolve just the registry credentials for a job's container.
 *
 * Split out of {@link resolveContainerSpawn} because the two consumers diverge
 * for a dockerfile build: there is no image for the SCALER to spawn an agent
 * from, but the AGENT still needs credentials to pull the Dockerfile's own
 * `FROM` base.
 *
 * Returns `undefined` when the job declared no credentials at all.
 */
export async function resolveContainerRegistryAuth(
  container: LockContainer,
  deps: ResolveContainerSpawnDeps,
): Promise<NonNullable<ResolvedContainerSpawn['authconfig']> | undefined> {
  if (container === undefined || typeof container === 'string') return undefined;

  const { image, auth } = container;
  if (!auth) return undefined;

  const bag = auth as unknown as Record<string, string | undefined>;
  const password = await sourced(bag, 'token', deps, true);
  const username =
    auth.username ?? (await sourced(bag, 'username', deps, false)) ?? 'x-access-token';

  // A dockerfile build names its base image INSIDE the Dockerfile, so there is
  // no reference to derive the registry host from and the author supplies it.
  // The SDK already requires it; this is the second gate, because a lock file
  // is repo content and is not trusted.
  const serveraddress = auth.registry ?? (image ? registryHostFromImageRef(image) : undefined);
  if (serveraddress === undefined) {
    throw new Error(
      `container registry credential: auth.registry is required when the job builds its ` +
        `image from a dockerfile (there is no image reference to derive the registry from)`,
    );
  }

  return { username, password: password as string, serveraddress };
}

/**
 * Turn a lock `container` field into an image plus, when the job declared
 * credentials, an authconfig for the registry that image lives in.
 *
 * Returns `undefined` for a job with no container at all — and for a job that
 * BUILDS its image, because the scaler cannot spawn an agent from an image that
 * does not exist yet. That job is run by an ordinary agent, which nests the
 * container after it has cloned and built. So a caller can treat "no container",
 * "container without auth" and "container built from a dockerfile" distinctly.
 */
export async function resolveContainerSpawn(
  container: LockContainer,
  deps: ResolveContainerSpawnDeps,
): Promise<ResolvedContainerSpawn | undefined> {
  if (container === undefined) return undefined;
  if (typeof container === 'string') return { image: container };

  const { image, env } = container;
  if (typeof image !== 'string' || image.length === 0) return undefined;

  const base: ResolvedContainerSpawn = { image, ...(env ? { env } : {}) };
  const authconfig = await resolveContainerRegistryAuth(container, deps);
  return authconfig ? { ...base, authconfig } : base;
}

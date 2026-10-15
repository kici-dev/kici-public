/**
 * Resolve a job's container spec into something a runtime can pull with.
 *
 * The lock carries credential REFERENCES (`<context>:<secret-name>`), never material. The
 * agent's container sandbox, the container scaler backend and the bare-metal backend in
 * container mode share this one resolver so their readings of the lock field cannot drift.
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
 * Mirrors `GitCredentialBroker.sourced` (same vocabulary and precedence), except that setting
 * BOTH halves is an error, matching the wire schema's `sourced()` refinement: quietly honouring
 * one of two intentions is how the wrong credential gets used.
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
 * Resolve just the registry credentials for a job's container; `undefined` when the job
 * declared none. Separate from {@link resolveContainerSpawn} because for a dockerfile build the
 * SCALER has no image to spawn from, but the AGENT still needs credentials for the `FROM` base.
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

  // A dockerfile build names its base INSIDE the Dockerfile, so the author
  // supplies the registry host. The SDK requires it too; this second gate
  // exists because a lock file is untrusted repo content.
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
 * Turn a lock `container` field into an image plus, when the job declared credentials, an
 * authconfig for that image's registry.
 *
 * Returns `undefined` for no container, and for a job that BUILDS its image: the scaler cannot
 * spawn from an image that does not exist yet, so an ordinary agent runs it and nests the
 * container after clone and build. A caller can treat "no container", "container without auth"
 * and "container built from a dockerfile" distinctly.
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

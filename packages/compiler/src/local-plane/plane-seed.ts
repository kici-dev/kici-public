/**
 * Seed the local `file://` source the plane dispatches an offline routed run
 * through. Idempotent: a stable `kici-local` source is created once and its
 * `repoBasePath` is re-pointed at the current workdir on every run (the isolated
 * profile materializes a fresh tmp clone each time). The org is the independent
 * orchestrator's `__default__` sentinel — the orchestrator DB has no org table,
 * so seeding an org is just passing this id.
 */

import { AdminApiClient } from '@kici-dev/orchestrator';

/** Independent-mode default org sentinel used by the local plane. */
export const LOCAL_ORG_ID = '__default__';
/** Stable name of the plane's local source (reused + re-pointed across runs). */
export const LOCAL_SOURCE_NAME = 'kici-local';

/** Minimal surface of AdminApiClient plane-seed needs (for test injection). */
export interface PlaneSeedClient {
  listGenericSources(
    orgId: string,
    includeDeleted?: boolean,
  ): Promise<{ sources: Array<{ id: string; name: string; provider_type?: string }> }>;
  createGenericSource(data: {
    orgId: string;
    name: string;
    providerType?: string;
    verificationMethod?: string;
    localConfig?: { repoBasePath: string; cloneUrlBase?: string; inPlace?: boolean };
  }): Promise<{ source: { id: string; name: string } }>;
  updateGenericSource(
    id: string,
    data: {
      localConfig?: { repoBasePath: string; cloneUrlBase?: string; inPlace?: boolean } | null;
    },
  ): Promise<{ source: { id: string; name: string } }>;
}

/** Result of seeding: the org + the (created or reused) source. */
export interface SeededSource {
  orgId: string;
  sourceId: string;
  sourceName: string;
}

/**
 * Ensure the plane has a local `file://` source pointed at `repoDir`. Creates
 * the `kici-local` source on first use; on subsequent runs it re-points the
 * existing source at the new workdir (idempotent reuse). Returns the org +
 * source ids the trigger uses.
 */
export async function ensureLocalSource(
  planeUrl: string,
  adminToken: string,
  opts: {
    repoDir: string;
    orgId?: string;
    name?: string;
    /**
     * In-place profile: `repoDir` is the operator's real working tree, so the
     * plane skips the source-pack `__build__` job and each job runs the tree
     * directly. Always written (true/false) so a subsequent isolated run resets
     * a previously in-place source.
     */
    inPlace?: boolean;
    client?: PlaneSeedClient;
  },
): Promise<SeededSource> {
  const orgId = opts.orgId ?? LOCAL_ORG_ID;
  const name = opts.name ?? LOCAL_SOURCE_NAME;
  const inPlace = opts.inPlace === true;
  const client: PlaneSeedClient = opts.client ?? new AdminApiClient(planeUrl, adminToken);

  const { sources } = await client.listGenericSources(orgId);
  const existing = sources.find((s) => s.name === name && s.provider_type === 'local');

  if (existing) {
    const updated = await client.updateGenericSource(existing.id, {
      localConfig: { repoBasePath: opts.repoDir, inPlace },
    });
    return { orgId, sourceId: updated.source.id, sourceName: updated.source.name };
  }

  const created = await client.createGenericSource({
    orgId,
    name,
    providerType: 'local',
    verificationMethod: 'none',
    localConfig: { repoBasePath: opts.repoDir, inPlace },
  });
  return { orgId, sourceId: created.source.id, sourceName: created.source.name };
}

/**
 * Seeds the local `file://` source an offline routed run dispatches through.
 * Idempotent: the `kici-local` source is created once and re-pointed at the
 * current workdir every run (the isolated profile clones a fresh tmp dir each
 * time). The orchestrator DB has no org table, so the org is just the
 * independent `__default__` sentinel id.
 */

import { AdminApiClient } from '@kici-dev/orchestrator';

export const LOCAL_ORG_ID = '__default__';
export const LOCAL_SOURCE_NAME = 'kici-local';

/** The AdminApiClient subset this module needs, for test injection. */
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

export interface SeededSource {
  orgId: string;
  sourceId: string;
  sourceName: string;
}

/** Creates the source on first use and re-points it at `repoDir` afterwards. */
export async function ensureLocalSource(
  planeUrl: string,
  adminToken: string,
  opts: {
    repoDir: string;
    orgId?: string;
    name?: string;
    /**
     * `repoDir` is the operator's real working tree: the plane skips the
     * source-pack `__build__` job. Always written, so a later isolated run
     * resets an in-place source.
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

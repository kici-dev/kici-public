/**
 * The org ids this orchestrator holds data for, and which data names each one.
 *
 * The org-scoped kici-admin commands (`secret`, `context`, `variable`,
 * `remote-source`, `org-settings`, `trust-policy`, `registration`) take an org
 * id. This module answers "which org ids exist here" from the configuration and
 * anchor tables, for both `GET /api/v1/admin/org-ids` and
 * `kici-admin org list --database-url`, so the two transports cannot disagree.
 */
import { sql, type Kysely } from 'kysely';
import { z } from 'zod';
import type { Database } from '../types.js';

/**
 * Where an org id was found. `platform` is the live Platform connection, which
 * only the admin API can see; every other value names a table.
 */
export const OrgIdSource = z.enum([
  'platform',
  'remote-source',
  'source',
  'generic-source',
  'context',
  'secret',
  'org-settings',
  'trust-policy',
  'registration',
]);
export type OrgIdSource = z.infer<typeof OrgIdSource>;

/**
 * The orchestrator's Platform attachment: `attached` once the Platform named
 * the org on `auth.success`, `pending` while a Platform client has not
 * authenticated yet, `none` when no Platform client runs (independent mode).
 */
export const PlatformAttachment = z.enum(['attached', 'pending', 'none']);
export type PlatformAttachment = z.infer<typeof PlatformAttachment>;

/** One org id and the data that names it. */
export interface HeldOrg {
  orgId: string;
  sources: OrgIdSource[];
}

/**
 * Body of `GET /api/v1/admin/org-ids`. The two Platform fields are absent when the
 * listing was read from the database directly: only the running orchestrator
 * knows its connection.
 */
export interface OrgListResponse {
  platformAttachment?: PlatformAttachment;
  attachedOrgId?: string | null;
  orgs: HeldOrg[];
}

/** The admin API path of the listing. */
export const ORG_LIST_PATH = '/api/v1/admin/org-ids';

interface OrgIdTable {
  table: keyof Database;
  column: 'org_id' | 'customer_id';
  source: Exclude<OrgIdSource, 'platform'>;
  /** Skip soft-deleted rows (`deleted_at IS NULL`). */
  liveOnly?: boolean;
}

/** The configuration and anchor tables an org-scoped command reads by org id. */
export const ORG_ID_TABLES: readonly OrgIdTable[] = [
  { table: 'remote_sources', column: 'customer_id', source: OrgIdSource.enum['remote-source'] },
  { table: 'sources', column: 'customer_id', source: OrgIdSource.enum.source },
  {
    table: 'generic_webhook_sources',
    column: 'customer_id',
    source: OrgIdSource.enum['generic-source'],
    liveOnly: true,
  },
  { table: 'contexts', column: 'org_id', source: OrgIdSource.enum.context },
  { table: 'scoped_secrets', column: 'org_id', source: OrgIdSource.enum.secret },
  { table: 'org_settings', column: 'customer_id', source: OrgIdSource.enum['org-settings'] },
  { table: 'org_trust_policy', column: 'customer_id', source: OrgIdSource.enum['trust-policy'] },
  { table: 'org_trust_directory', column: 'customer_id', source: OrgIdSource.enum['trust-policy'] },
  {
    table: 'workflow_registrations',
    column: 'customer_id',
    source: OrgIdSource.enum.registration,
  },
];

const RUN_HISTORY =
  'run history: the row copies its org id from a listed table or the Platform connection, and the table grows without bound';
const CONTEXT_CHILD = 'child rows of contexts: the contexts row already names the org';

/**
 * Every other table with an `org_id` or `customer_id` column, and why the
 * listing does not read it. A schema test fails when a migration adds an
 * org-keyed table that is in neither this map nor {@link ORG_ID_TABLES}.
 */
export const ORG_ID_TABLES_NOT_LISTED: Readonly<Record<string, string>> = {
  execution_runs: RUN_HISTORY,
  event_log: RUN_HISTORY,
  access_log: RUN_HISTORY,
  artifacts: RUN_HISTORY,
  held_runs: RUN_HISTORY,
  batch_accumulation_windows: RUN_HISTORY,
  pending_workflow_contexts: RUN_HISTORY,
  context_bindings: CONTEXT_CHILD,
  context_variables: CONTEXT_CHILD,
  context_source_overrides: CONTEXT_CHILD,
};

function compareOrgIds(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Group `(org id, source)` rows per org: org ids in byte order, sources in enum order. */
export function groupOrgIdRows(
  rows: ReadonlyArray<{ org_id: string; source: OrgIdSource }>,
): HeldOrg[] {
  const byOrg = new Map<string, Set<OrgIdSource>>();
  for (const row of rows) {
    let sources = byOrg.get(row.org_id);
    if (!sources) {
      sources = new Set();
      byOrg.set(row.org_id, sources);
    }
    sources.add(row.source);
  }
  return [...byOrg.keys()].sort(compareOrgIds).map((orgId) => ({
    orgId,
    sources: OrgIdSource.options.filter((s) => byOrg.get(orgId)!.has(s)),
  }));
}

/** Add the Platform-attached org to a listing, with the `platform` source. */
export function withPlatformOrg(orgs: readonly HeldOrg[], attachedOrgId: string | null): HeldOrg[] {
  if (attachedOrgId === null) return [...orgs];
  return groupOrgIdRows([
    { org_id: attachedOrgId, source: OrgIdSource.enum.platform },
    ...orgs.flatMap((o) => o.sources.map((source) => ({ org_id: o.orgId, source }))),
  ]);
}

/** The attachment the admin API reports, from the Platform client's org id reader. */
export function readPlatformAttachment(getPlatformOrgId: (() => string | undefined) | undefined): {
  platformAttachment: PlatformAttachment;
  attachedOrgId: string | null;
} {
  if (!getPlatformOrgId) {
    return { platformAttachment: PlatformAttachment.enum.none, attachedOrgId: null };
  }
  const orgId = getPlatformOrgId();
  return orgId
    ? { platformAttachment: PlatformAttachment.enum.attached, attachedOrgId: orgId }
    : { platformAttachment: PlatformAttachment.enum.pending, attachedOrgId: null };
}

/** Every org id the listed tables hold, in one round trip. */
export async function listHeldOrgIds(db: Kysely<Database>): Promise<HeldOrg[]> {
  const selects = ORG_ID_TABLES.map(
    (t) =>
      sql`SELECT DISTINCT ${sql.ref(t.column)} AS org_id, ${t.source}::text AS source
            FROM ${sql.table(t.table)}
           WHERE ${t.liveOnly ? sql`deleted_at IS NULL` : sql`TRUE`}`,
  );
  const { rows } = await sql<{ org_id: string; source: OrgIdSource }>`${sql.join(
    selects,
    sql` UNION `,
  )}`.execute(db);
  return groupOrgIdRows(rows);
}

/**
 * `kici-admin org list` — every org id this orchestrator holds data for.
 *
 * Reads `GET /api/v1/admin/org-ids` by default. With `--database-url` (or
 * KICI_DATABASE_URL) it runs the same query against the orchestrator database
 * directly; that mode cannot see the live Platform connection, so it lists no
 * `platform` source and says so.
 */
import type { Command } from 'commander';
import { toErrorMessage } from '@kici-dev/shared';
import type { AdminApiClient } from '../api-client.js';
import {
  listHeldOrgIds,
  ORG_LIST_PATH,
  PlatformAttachment,
  type OrgListResponse,
} from '../../db/repos/org-ids-repo.js';
import {
  cliAction,
  DIRECT_DB_URL_FLAG,
  DIRECT_DB_URL_HELP,
  printJsonOr,
  resolveDirectDbUrl,
} from './shared/cli-action.js';
import { renderTable } from './shared/table.js';
import { withDb } from './shared/db.js';

const OFFLINE_NOTE =
  'Note: read from the database (--database-url or KICI_DATABASE_URL), so the live Platform ' +
  'attachment is not shown. Leave both unset to read it over the admin API.\n';

const PENDING_NOTE =
  'Note: the orchestrator has not authenticated with the Platform yet, so its Platform org is not listed.\n';

/** Print the listing as a table, with a note when it lacks the Platform attachment. */
function printOrgList(result: OrgListResponse): void {
  if (result.orgs.length === 0) {
    console.log('No org ids found.');
  } else {
    console.log(
      renderTable(
        ['ORG ID', 'SOURCES'],
        result.orgs.map((o) => [o.orgId, o.sources.join(', ')]),
      ),
    );
  }
  if (result.platformAttachment === undefined) process.stderr.write(OFFLINE_NOTE);
  else if (result.platformAttachment === PlatformAttachment.enum.pending) {
    process.stderr.write(PENDING_NOTE);
  }
}

async function listOverHttp(client: AdminApiClient): Promise<OrgListResponse> {
  try {
    return await client.get<OrgListResponse>(ORG_LIST_PATH);
  } catch (err) {
    const message = toErrorMessage(err);
    if (!message.startsWith('HTTP 404')) throw err;
    throw new Error(
      `${message}. This orchestrator has no org listing: it predates kici-admin org list. ` +
        'Upgrade it, or read its database with --database-url.',
      { cause: err },
    );
  }
}

export function registerOrgCommands(program: Command, getClient: () => AdminApiClient): void {
  const org = program
    .command('org')
    .description('Inspect the org ids this orchestrator holds data for');

  org
    .command('list')
    .description(
      'List every org id this orchestrator holds data for, and the data that names it ' +
        '(the Platform connection, sources, contexts, secrets, org settings, trust policy, registrations)',
    )
    .option(DIRECT_DB_URL_FLAG, DIRECT_DB_URL_HELP)
    .option('--json', 'Emit JSON output')
    .action(
      cliAction(async (opts: { databaseUrl?: string; json?: boolean }) => {
        const dbUrl = resolveDirectDbUrl(opts.databaseUrl);
        const result: OrgListResponse = dbUrl
          ? { orgs: await withDb((db) => listHeldOrgIds(db), dbUrl) }
          : await listOverHttp(getClient());
        printJsonOr(opts.json, result, printOrgList);
      }),
    );
}

/**
 * Workflow registration read CLI commands for kici-admin (5a #4).
 *
 *   registration list [--org <id>] [--routing-key <k>] [--repo <ident>] [--limit <n>]
 *   registration show <id>
 *
 * A distinct namespace from `workflow list` — `workflow` is workflow-code,
 * `registration` is the registered-workflow-instance row in
 * workflow_registrations. Both coexist; the existing `workflow list` is
 * untouched by this plan.
 *
 * Dual-mode: HTTP (via AdminApiClient on the existing
 * /api/v1/admin/registrations admin API) or `--database-url` (direct DB).
 */
import type { Command } from 'commander';
import type { AdminApiClient } from '../api-client.js';
import {
  listRegistrationsDirect,
  showRegistrationDirect,
  toErrorMessage,
  type WorkflowRegistrationRow,
  type ShowRegistrationResult,
} from '@kici-dev/shared';

function resolveDirectDbUrl(explicit?: string): string | null {
  return explicit ?? process.env.KICI_DATABASE_URL ?? null;
}

function parseIntOption(raw: string | undefined, label: string): number | undefined {
  if (raw === undefined) return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n) || Math.floor(n) !== n) {
    throw new Error(`${label}: must be an integer (got "${raw}")`);
  }
  return n;
}

function printRegistrationsTable(rows: WorkflowRegistrationRow[]): void {
  if (rows.length === 0) {
    console.log('No registrations found.');
    return;
  }
  const header = ['ID', 'REPO', 'WORKFLOW', 'ROUTING', 'TRIGGERS', 'DISABLED'];
  const data = rows.map((r) => [
    r.id.slice(0, 8),
    r.repo_identifier,
    r.workflow_name,
    r.routing_key,
    (r.trigger_types ?? []).join(','),
    String(r.disabled),
  ]);
  const widths = header.map((h, i) => Math.max(h.length, ...data.map((row) => row[i].length)));
  const pad = (s: string, w: number) => s + ' '.repeat(Math.max(0, w - s.length));
  console.log(header.map((h, i) => pad(h, widths[i])).join('  '));
  for (const r of data) console.log(r.map((c, i) => pad(c, widths[i])).join('  '));
}

function printRegistrationShow(res: ShowRegistrationResult): void {
  const r = res.registration;
  console.log(`id:            ${r.id}`);
  console.log(`repo:          ${r.repo_identifier}`);
  console.log(`workflow:      ${r.workflow_name}`);
  console.log(`routing_key:   ${r.routing_key}`);
  console.log(`customer_id:   ${r.customer_id}`);
  console.log(`triggers:      ${(r.trigger_types ?? []).join(',')}`);
  console.log(`disabled:      ${r.disabled}`);
  console.log(`is_global:     ${r.is_global}`);
  console.log(`commit_sha:    ${r.commit_sha ?? '-'}`);
  console.log(`source_file:   ${r.source_file ?? '-'}`);
  console.log(`registry_version: ${res.registryVersion ?? '-'}`);
  console.log(`created_at:    ${r.created_at}`);
  console.log(`updated_at:    ${r.updated_at}`);
}

export function registerRegistrationCommands(
  program: Command,
  getClient: () => AdminApiClient,
): void {
  const reg = program
    .command('registration')
    .description('Registered workflow instance read (workflow_registrations table)');

  reg
    .command('list')
    .description('List workflow_registrations rows (also returns registry_version)')
    .option('--org <id>', 'Filter by customer_id')
    .option('--routing-key <k>', 'Filter by routing_key')
    .option('--repo <ident>', 'Filter by repo_identifier')
    .option('--trigger-type <type>', 'Filter by trigger type (in trigger_types[])')
    .option('--limit <n>', 'Max rows (default 100, max 1000)')
    .option('--database-url <url>', 'Use direct DB access instead of HTTP (offline mode)')
    .option('--json', 'Emit JSON output')
    .action(async (opts) => {
      try {
        const limit = parseIntOption(opts.limit, '--limit');
        const query = {
          customerId: opts.org,
          routingKey: opts.routingKey,
          repoIdentifier: opts.repo,
          triggerType: opts.triggerType,
          limit,
        };
        const dbUrl = resolveDirectDbUrl(opts.databaseUrl);
        if (dbUrl) {
          const result = await listRegistrationsDirect(dbUrl, query);
          if (opts.json) console.log(JSON.stringify(result));
          else printRegistrationsTable(result.registrations);
        } else {
          const params = new URLSearchParams();
          if (opts.org) params.set('customerId', opts.org);
          if (opts.routingKey) params.set('routingKey', opts.routingKey);
          if (opts.repo) params.set('repoIdentifier', opts.repo);
          if (opts.triggerType) params.set('triggerType', opts.triggerType);
          const qs = params.toString();
          // The existing admin-registrations route returns { registrations, total }.
          // Shape it into our { registrations } so callers get the same surface.
          const result = await getClient().get<{
            registrations: WorkflowRegistrationRow[];
            total?: number;
            registryVersion?: number | null;
          }>(`/api/v1/admin/registrations${qs ? `?${qs}` : ''}`);
          if (opts.json) console.log(JSON.stringify(result));
          else printRegistrationsTable(result.registrations);
        }
      } catch (err) {
        console.error(`Error: ${toErrorMessage(err)}`);
        process.exit(1);
      }
    });

  reg
    .command('show <id>')
    .description('Show a single workflow_registrations row by id')
    .option('--database-url <url>', 'Use direct DB access instead of HTTP (offline mode)')
    .option('--json', 'Emit JSON output')
    .action(async (id: string, opts) => {
      try {
        const dbUrl = resolveDirectDbUrl(opts.databaseUrl);
        const result = dbUrl
          ? await showRegistrationDirect(dbUrl, { id })
          : await getClient().get<ShowRegistrationResult>(
              `/api/v1/admin/registrations/${encodeURIComponent(id)}`,
            );
        if (opts.json) console.log(JSON.stringify(result));
        else printRegistrationShow(result);
      } catch (err) {
        console.error(`Error: ${toErrorMessage(err)}`);
        process.exit(1);
      }
    });
}

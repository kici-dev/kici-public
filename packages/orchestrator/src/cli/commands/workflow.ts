/**
 * Workflow registration commands for kici-admin.
 *
 * Provides operator-facing read access to the workflow_registrations table
 * via the orchestrator's admin HTTP API. This is the dogfooded replacement
 * for "let me just psql the registration table" — every CLI subcommand here
 * goes through AdminApiClient and the existing /api/v1/admin/registrations
 * route.
 *
 *   workflow list                List registered workflows (table or JSON)
 *
 * Filter flags map 1:1 to the route's query string params:
 *   --org              -> ?customerId=<id>
 *   --routing-key      -> ?routingKey=<key>
 *   --repo             -> ?repoIdentifier=<owner/repo>
 *   --trigger-type     -> ?triggerType=<type>
 *   --event            -> ?event=<eventName>
 *
 * Output:
 *   default            Aligned ASCII table with id, repo_identifier,
 *                      workflow_name, trigger_types, events, disabled
 *                      (plus org_id when --org is omitted)
 *   --json             Raw JSON.stringify of the full response
 */

import { readFileSync } from 'node:fs';
import type { Command } from 'commander';
import type { AdminApiClient } from '../api-client.js';
import {
  registerWorkflowManualDirect,
  toErrorMessage,
  type RegisterWorkflowManualResult,
} from '@kici-dev/shared';

function resolveDirectDbUrl(explicit?: string): string | null {
  return explicit ?? process.env.KICI_DATABASE_URL ?? null;
}

function parseJsonOption(raw: string | undefined, label: string): Record<string, unknown> {
  if (raw === undefined || raw === '') return {};
  try {
    const parsed = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new Error(`${label}: expected a JSON object`);
    }
    return parsed as Record<string, unknown>;
  } catch (err) {
    throw new Error(`${label}: invalid JSON — ${toErrorMessage(err)}`);
  }
}

/**
 * Row shape returned by GET /api/v1/admin/registrations.
 *
 * Mirrors RegistrationRow on the server side, but kept loose here so the
 * CLI doesn't grow a hard import dependency on the orchestrator's
 * registration package.
 */
interface RegistrationRowDTO {
  id: string;
  customerId: string;
  routing_key: string;
  repo_identifier: string;
  workflow_name: string;
  trigger_types: string[];
  lock_entry: {
    triggers?: Array<{ _type: string; events?: string[] }>;
  };
  provider_context?: Record<string, unknown>;
  disabled: boolean;
}

interface ListResponse {
  registrations: RegistrationRowDTO[];
  total: number;
}

/**
 * Build the /api/v1/admin/registrations query string from CLI options.
 * Exported only for testing — order is preserved (org → routingKey → repo →
 * triggerType → event) so test assertions can match exact strings.
 */
function buildQueryString(opts: {
  org?: string;
  routingKey?: string;
  repo?: string;
  triggerType?: string;
  event?: string;
}): string {
  const params = new URLSearchParams();
  if (opts.org) params.set('customerId', opts.org);
  if (opts.routingKey) params.set('routingKey', opts.routingKey);
  if (opts.repo) params.set('repoIdentifier', opts.repo);
  if (opts.triggerType) params.set('triggerType', opts.triggerType);
  if (opts.event) params.set('event', opts.event);
  const qs = params.toString();
  return qs ? `?${qs}` : '';
}

/**
 * Extract webhook event names from a registration's lock_entry.triggers[].
 * Non-webhook triggers are skipped. Returns the union of all events across
 * webhook triggers in declaration order, deduplicated.
 */
function extractWebhookEvents(row: RegistrationRowDTO): string[] {
  const triggers = row.lock_entry?.triggers ?? [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const t of triggers) {
    if (t._type !== 'webhook') continue;
    for (const e of t.events ?? []) {
      if (!seen.has(e)) {
        seen.add(e);
        out.push(e);
      }
    }
  }
  return out;
}

/**
 * Render an aligned ASCII table.
 *
 * Mirrors the simple `padEnd` style used by commands/source.ts —
 * deliberately no `cli-table` dependency.
 */
function renderTable(headers: string[], rows: string[][]): string {
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] ?? '').length)));

  const fmtRow = (cells: string[]) =>
    cells
      .map((c, i) => (c ?? '').padEnd(widths[i]!))
      .join('  ')
      .trimEnd();

  const lines: string[] = [];
  lines.push(fmtRow(headers));
  lines.push(widths.map((w) => '-'.repeat(w)).join('  '));
  for (const r of rows) lines.push(fmtRow(r));
  return lines.join('\n');
}

/**
 * Register the `workflow` command group with kici-admin.
 */
export function registerWorkflowCommands(program: Command, getClient: () => AdminApiClient): void {
  const wf = program.command('workflow').description('Inspect workflow registrations');

  wf.command('list')
    .description('List workflow registrations (dogfooded via /api/v1/admin/registrations)')
    .option('--org <orgId>', 'Filter by customer/org id (server param: customerId)')
    .option('--routing-key <key>', 'Filter by routing key, e.g. github:42')
    .option('--repo <ownerRepo>', 'Filter by repo identifier (owner/repo)')
    .option('--trigger-type <type>', 'Filter by trigger type, e.g. webhook, push, schedule')
    .option('--event <eventName>', 'Filter by webhook event name (scans lock_entry.triggers)')
    .option('--json', 'Emit raw JSON instead of a table')
    .action(async (opts) => {
      try {
        const qs = buildQueryString({
          org: opts.org,
          routingKey: opts.routingKey,
          repo: opts.repo,
          triggerType: opts.triggerType,
          event: opts.event,
        });
        const path = `/api/v1/admin/registrations${qs}`;
        const response = await getClient().get<ListResponse>(path);

        if (opts.json) {
          console.log(JSON.stringify(response, null, 2));
          return;
        }

        if (response.registrations.length === 0) {
          console.log('No workflow registrations found.');
          return;
        }

        const includeOrgColumn = !opts.org;
        const headers = [
          'id',
          ...(includeOrgColumn ? ['org_id'] : []),
          'repo_identifier',
          'workflow_name',
          'trigger_types',
          'events',
          'disabled',
        ];
        const rows = response.registrations.map((r) => {
          const events = extractWebhookEvents(r).join(',');
          return [
            r.id,
            ...(includeOrgColumn ? [r.customerId ?? ''] : []),
            r.repo_identifier,
            r.workflow_name,
            (r.trigger_types ?? []).join(','),
            events,
            String(r.disabled),
          ];
        });

        console.log(renderTable(headers, rows));
        console.log('');
        console.log(`Total: ${response.total}`);
      } catch (err) {
        console.error(`Error: ${toErrorMessage(err)}`);
        process.exit(1);
      }
    });

  wf.command('register-manual')
    .description(
      'Manually upsert workflow_registrations rows from a lock file + bump registry_versions. ' +
        'Transactional. Used by E2E helpers that seed registrations without a real push event.',
    )
    .requiredOption('--lock-file <path>', 'Path to a kici.lock.json file')
    .requiredOption('--repo <ident>', 'repo_identifier value (e.g. "owner/repo")')
    .requiredOption('--routing-key <key>', 'Routing key for the source (e.g. "github:42")')
    .requiredOption('--customer <id>', 'customer_id (org) to attribute rows to')
    .option(
      '--provider-context <json>',
      'Provider-specific context as a JSON object (default: {})',
      '{}',
    )
    .option('--commit-sha <sha>', 'Optional commit SHA stamped on each row')
    .option('--database-url <url>', 'Use direct DB access instead of HTTP (offline mode)')
    .option('--json', 'Emit JSON output')
    .action(async (opts) => {
      try {
        const lockFileContents = readFileSync(opts.lockFile, 'utf-8');
        const providerContext = parseJsonOption(opts.providerContext, '--provider-context');
        const payload = {
          lockFileContents,
          repoIdentifier: opts.repo,
          routingKey: opts.routingKey,
          customerId: opts.customer,
          providerContext,
          commitSha: opts.commitSha,
        };
        const dbUrl = resolveDirectDbUrl(opts.databaseUrl);
        const result: RegisterWorkflowManualResult = dbUrl
          ? await registerWorkflowManualDirect(dbUrl, payload)
          : await getClient().post<RegisterWorkflowManualResult>(
              '/api/v1/admin/registrations/register-manual',
              payload,
            );
        if (opts.json) {
          console.log(JSON.stringify(result));
        } else {
          console.log(
            `workflow register-manual: workflowCount=${result.workflowCount} registryVersion=${result.registryVersion}${dbUrl ? ' (direct)' : ''}`,
          );
        }
      } catch (err) {
        console.error(`Error: ${toErrorMessage(err)}`);
        process.exit(1);
      }
    });
}

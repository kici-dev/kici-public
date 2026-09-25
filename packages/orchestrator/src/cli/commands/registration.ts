/**
 * Workflow registration CLI commands for kici-admin.
 *
 *   registration list [--org <id>] [--routing-key <k>] [--repo <ident>] [--limit <n>]
 *   registration show <id>
 *   registration disable <id> | enable <id>
 *   registration delete <id> [--yes]
 *
 * A distinct namespace from `workflow list` — `workflow` is workflow-code,
 * `registration` is the registered-workflow-instance row in
 * workflow_registrations. Both coexist.
 *
 * `list` and `show` are dual-mode: HTTP (via AdminApiClient on the
 * /api/v1/admin/registrations admin API) or `--database-url` (direct DB).
 * `disable`, `enable` and `delete` are HTTP only: they are the operator path
 * for the dashboard's registration writes, and the admin route bumps the
 * registry version so every peer reloads.
 */
import type { Command } from 'commander';
import type { AdminApiClient } from '../api-client.js';
import { confirmPrompt } from './shared/confirm.js';
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
    .description('Registered workflow instances (workflow_registrations table)');

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

  registerRegistrationWriteCommands(reg, getClient);
}

/** Response of `PATCH /api/v1/admin/registrations/:id/disable`. */
interface DisableResult {
  disabled: boolean;
  registryVersion: number;
}

/**
 * `registration disable|enable|delete` — the operator path for the dashboard's
 * `registration.disable` / `registration.delete` writes. `enable` is the same
 * admin route as `disable`, with the flag cleared.
 */
function registerRegistrationWriteCommands(reg: Command, getClient: () => AdminApiClient): void {
  const setDisabled = async (id: string, disabled: boolean, json?: boolean): Promise<void> => {
    try {
      const result = await getClient().patch<DisableResult>(
        `/api/v1/admin/registrations/${encodeURIComponent(id)}/disable`,
        { disabled },
      );
      if (json) {
        console.log(JSON.stringify(result));
      } else {
        console.log(
          `registration ${disabled ? 'disable' : 'enable'}: id=${id} ` +
            `disabled=${result.disabled} registry_version=${result.registryVersion}`,
        );
      }
    } catch (err) {
      console.error(`Error: ${toErrorMessage(err)}`);
      process.exit(1);
    }
  };

  reg
    .command('disable <id>')
    .description(
      'Disable a workflow registration: it stays registered, but its triggers stop dispatching',
    )
    .option('--json', 'Emit JSON output')
    .action(async (id: string, opts: { json?: boolean }) => setDisabled(id, true, opts.json));

  reg
    .command('enable <id>')
    .description('Re-enable a disabled workflow registration')
    .option('--json', 'Emit JSON output')
    .action(async (id: string, opts: { json?: boolean }) => setDisabled(id, false, opts.json));

  reg
    .command('delete <id>')
    .description('Delete a workflow registration by id')
    .option('--yes', 'Skip confirmation prompt')
    .option('--json', 'Emit JSON output')
    .action(async (id: string, opts: { yes?: boolean; json?: boolean }) => {
      try {
        if (!opts.yes) {
          const confirmed = await confirmPrompt(
            `Are you sure you want to delete registration '${id}'? [y/N] `,
          );
          if (!confirmed) {
            console.log('Aborted.');
            return;
          }
        }
        const result = await getClient().delete<{ deleted: boolean; registryVersion: number }>(
          `/api/v1/admin/registrations/${encodeURIComponent(id)}`,
        );
        if (opts.json) {
          console.log(JSON.stringify(result));
        } else {
          console.log(
            `registration delete: id=${id} deleted=${result.deleted} ` +
              `registry_version=${result.registryVersion}`,
          );
        }
      } catch (err) {
        console.error(`Error: ${toErrorMessage(err)}`);
        process.exit(1);
      }
    });
}

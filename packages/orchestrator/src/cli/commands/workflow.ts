/**
 * `kici-admin workflow`: workflow_registrations through the admin API
 * (/api/v1/admin/registrations), instead of psql. `list` filter flags map 1:1
 * to the route's query params.
 */

import { readFileSync } from 'node:fs';
import type { Command } from 'commander';
import type { AdminApiClient } from '../api-client.js';
import {
  registerWorkflowManualDirect,
  toErrorMessage,
  type RegisterWorkflowManualResult,
} from '@kici-dev/shared';
import {
  cliAction,
  resolveDirectDbUrl,
  DIRECT_DB_URL_FLAG,
  DIRECT_DB_URL_HELP,
} from './shared/cli-action.js';
import { renderTable } from './shared/table.js';
import {
  formatStaleLockWarning,
  staleCompileSchemaEntries,
} from '../../registration/compile-schema-staleness.js';

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
 * A GET /api/v1/admin/registrations row: a loose mirror of the server's
 * RegistrationRow, so the CLI does not import the registration package.
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
  /** The schema the lock declares; absent from servers before the field, null when none. */
  compileSchemaVersion?: number | null;
  /** The schema the server release's agents implement; absent from older servers. */
  agentCompileSchemaVersion?: number;
}

/** A lock the server's agents reject: both schemas known and different. */
function isStaleRow(r: RegistrationRowDTO): boolean {
  return (
    typeof r.compileSchemaVersion === 'number' &&
    typeof r.agentCompileSchemaVersion === 'number' &&
    r.compileSchemaVersion !== r.agentCompileSchemaVersion
  );
}

/** The `schema` column: the lock's schema, marked when this release's agents reject it. */
function schemaCell(r: RegistrationRowDTO): string {
  if (typeof r.compileSchemaVersion !== 'number') return '-';
  return isStaleRow(r) ? `${r.compileSchemaVersion} (stale)` : String(r.compileSchemaVersion);
}

/** The direct-DB result, with `warnings` only when there is one (the output stays additive). */
function withDirectWarnings(
  result: RegisterWorkflowManualResult,
  warnings: string[],
): RegisterWorkflowManualResult {
  return warnings.length > 0 ? { ...result, warnings } : result;
}

/**
 * Warnings for a lock file registered straight into the database: there is no
 * server to compute them, so this CLI release's own compile schema decides.
 */
function directRegisterWarnings(lockFileContents: string, repoIdentifier: string): string[] {
  let workflows: unknown;
  try {
    workflows = (JSON.parse(lockFileContents) as { workflows?: unknown }).workflows;
  } catch {
    return [];
  }
  if (!Array.isArray(workflows)) return [];
  return staleCompileSchemaEntries(
    workflows.map((w: { name?: unknown }) => ({
      repoIdentifier,
      workflowName: typeof w?.name === 'string' ? w.name : '(unnamed)',
      lockEntry: w,
    })),
  ).map((e) => formatStaleLockWarning(e));
}

interface ListResponse {
  registrations: RegistrationRowDTO[];
  total: number;
}

/** Fixed param order (org, routingKey, repo, triggerType, event), so tests match exact strings. */
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

/** Deduplicated webhook event names across lock_entry.triggers, in declaration order. */
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

export function registerWorkflowCommands(program: Command, getClient: () => AdminApiClient): void {
  const wf = program.command('workflow').description('Inspect workflow registrations');

  wf.command('list')
    .description('List workflow registrations (admin API: /api/v1/admin/registrations)')
    .option('--org <orgId>', 'Filter by customer/org id (server param: customerId)')
    .option('--routing-key <key>', 'Filter by routing key, e.g. github:42')
    .option('--repo <ownerRepo>', 'Filter by repo identifier (owner/repo)')
    .option('--trigger-type <type>', 'Filter by trigger type, e.g. webhook, push, schedule')
    .option('--event <eventName>', 'Filter by webhook event name (scans lock_entry.triggers)')
    .option('--json', 'Emit raw JSON instead of a table')
    .action(
      cliAction(async (opts) => {
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
          'schema',
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
            schemaCell(r),
            String(r.disabled),
          ];
        });

        console.log(renderTable(headers, rows));
        console.log('');
        console.log(`Total: ${response.total}`);
        const stale = response.registrations.filter(isStaleRow);
        if (stale.length > 0) {
          console.log(
            `Warning: ${stale.length} registered workflow lock(s) declare a compile schema that ` +
              `this orchestrator's agents do not implement (schema ${stale[0]!.agentCompileSchemaVersion}). ` +
              `Their runs fail. Recompile each lock with the matching @kici-dev/compiler release ` +
              `and commit .kici/kici.lock.json.`,
          );
        }
      }),
    );

  wf.command('register-manual')
    .description(
      'Upsert workflow_registrations rows from a lock file and bump registry_versions. ' +
        'Transactional. Never removes a registration the lock file does not name (use ' +
        'registration delete). Seeds workflow registrations without a real push event.',
    )
    .requiredOption('--lock-file <path>', 'Path to a kici.lock.json file')
    .requiredOption('--repo <ident>', 'repo_identifier value (e.g. "owner/repo")')
    .requiredOption('--routing-key <key>', 'Routing key for the source (e.g. "github:42")')
    .requiredOption('--org <id>', 'Org id to attribute rows to')
    .option('--provider-context <json>', 'Provider-specific context as a JSON object', '{}')
    .option('--commit-sha <sha>', 'Optional commit SHA stamped on each row')
    .option(DIRECT_DB_URL_FLAG, DIRECT_DB_URL_HELP)
    .option('--json', 'Emit JSON output')
    .action(
      cliAction(async (opts) => {
        const lockFileContents = readFileSync(opts.lockFile, 'utf-8');
        const providerContext = parseJsonOption(opts.providerContext, '--provider-context');
        const payload = {
          lockFileContents,
          repoIdentifier: opts.repo,
          routingKey: opts.routingKey,
          customerId: opts.org,
          providerContext,
          commitSha: opts.commitSha,
        };
        const dbUrl = resolveDirectDbUrl(opts.databaseUrl);
        const result: RegisterWorkflowManualResult = dbUrl
          ? withDirectWarnings(
              await registerWorkflowManualDirect(dbUrl, payload),
              directRegisterWarnings(lockFileContents, opts.repo),
            )
          : await getClient().post<RegisterWorkflowManualResult>(
              '/api/v1/admin/registrations/register-manual',
              payload,
            );
        for (const warning of result.warnings ?? []) {
          if (!opts.json) console.error(`Warning: ${warning}`);
        }
        if (opts.json) {
          console.log(JSON.stringify(result));
        } else {
          console.log(
            `workflow register-manual: workflowCount=${result.workflowCount} registryVersion=${result.registryVersion}${dbUrl ? ' (direct)' : ''}`,
          );
        }
      }),
    );
}

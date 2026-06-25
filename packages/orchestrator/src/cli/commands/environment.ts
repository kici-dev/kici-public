/**
 * Environment management CLI commands for kici-admin.
 *
 *   environment create         — upsert an environment
 *   environment bind           — bind a scope pattern to an environment
 *   environment set-policy     — update policy fields (branch, reviewers, timers, trust)
 *   environment list           — list environments for an org
 *   environment show           — show a single environment with variables + bindings
 *   environment delete         — delete an environment (cascades bindings, variables, overrides; held-run history survives; pending held runs block with a clear error, resolved holds do not)
 *   environment create-template — create/update an environment template + its seed variables
 *
 * Each command supports two modes (stage-4 pattern from `maintenance.ts`):
 *
 *   HTTP mode (default): requires `--url` + `--token`, routes through the
 *   orchestrator admin HTTP API at /api/v1/admin/environments.
 *
 *   Direct-DB mode: activated when `--database-url` is passed (or
 *   KICI_DATABASE_URL / DATABASE_URL is set). Opens its own pool and runs the
 *   SQL directly via *Direct helpers in @kici-dev/shared. Used by E2E
 *   `globalSetup` helpers that need to seed envs before the orchestrator is up.
 */
import type { Command } from 'commander';
import {
  createEnvironmentTemplateDirect,
  deleteEnvironmentDirect,
  listEnvironmentsDirect,
  seedEnvironmentBindingDirect,
  seedEnvironmentDirect,
  setEnvironmentPolicyDirect,
  showEnvironmentDirect,
  toErrorMessage,
} from '@kici-dev/shared';
import type {
  EnvironmentRow,
  ShowEnvironmentResult,
  SeedEnvironmentResult,
} from '@kici-dev/shared';
import type { AdminApiClient } from '../api-client.js';

function resolveDirectDbUrl(explicit?: string): string | null {
  return explicit ?? process.env.KICI_DATABASE_URL ?? null;
}

function parseJsonOption(raw: string | undefined, label: string): unknown | undefined {
  if (raw === undefined) return undefined;
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new Error(`${label}: invalid JSON — ${toErrorMessage(err)}`);
  }
}

function parseCsvOption(raw: string | undefined): string[] | undefined {
  if (raw === undefined) return undefined;
  if (raw === '') return [];
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function parseIntOption(raw: string | undefined, label: string): number | undefined {
  if (raw === undefined) return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n) || Math.floor(n) !== n) {
    throw new Error(`${label}: must be an integer (got "${raw}")`);
  }
  return n;
}

/** Stringify policy fields for table output. */
function summarizePolicy(env: EnvironmentRow): string {
  const parts: string[] = [];
  try {
    const br =
      typeof env.branch_restrictions === 'string'
        ? JSON.parse(env.branch_restrictions)
        : env.branch_restrictions;
    if (Array.isArray(br) && br.length > 0) parts.push(`branches=${br.join('|')}`);
  } catch {
    // ignore parse errors
  }
  try {
    const rr =
      typeof env.required_reviewers === 'string'
        ? JSON.parse(env.required_reviewers)
        : env.required_reviewers;
    if (Array.isArray(rr) && rr.length > 0) parts.push(`reviewers=${rr.length}`);
  } catch {
    // ignore
  }
  if (env.wait_timer_seconds != null) parts.push(`wait=${env.wait_timer_seconds}s`);
  if (env.hold_expiry_seconds != null) parts.push(`hold=${env.hold_expiry_seconds}s`);
  if (env.minimum_trust) parts.push(`trust=${env.minimum_trust}`);
  return parts.length === 0 ? '-' : parts.join(' ');
}

function printEnvironmentTable(rows: EnvironmentRow[]): void {
  if (rows.length === 0) {
    console.log('No environments found.');
    return;
  }
  const header = ['NAME', 'TYPE', 'ENABLED', 'POLICY'];
  const data = rows.map((r) => [r.name, r.type, String(r.enabled), summarizePolicy(r)]);
  const widths = header.map((h, i) => Math.max(h.length, ...data.map((row) => row[i].length)));
  const pad = (s: string, w: number) => s + ' '.repeat(Math.max(0, w - s.length));
  console.log(header.map((h, i) => pad(h, widths[i])).join('  '));
  for (const row of data) {
    console.log(row.map((c, i) => pad(c, widths[i])).join('  '));
  }
}

function printShowEnvironment(res: ShowEnvironmentResult): void {
  const e = res.environment;
  console.log(`id:      ${e.id}`);
  console.log(`org:     ${e.org_id}`);
  console.log(`name:    ${e.name}`);
  console.log(`type:    ${e.type}`);
  console.log(`enabled: ${e.enabled}`);
  console.log(`policy:  ${summarizePolicy(e)}`);
  if (res.variables.length > 0) {
    console.log(`variables (${res.variables.length}):`);
    for (const v of res.variables) {
      console.log(`  ${v.key}=${v.value}${v.locked ? ' (locked)' : ''}`);
    }
  } else {
    console.log('variables: none');
  }
  if (res.bindings.length > 0) {
    console.log(`bindings (${res.bindings.length}):`);
    for (const b of res.bindings) {
      const host = b.host_pattern && b.host_pattern !== '**' ? `  (host: ${b.host_pattern})` : '';
      console.log(`  ${b.scope_pattern}${host}`);
    }
  } else {
    console.log('bindings: none');
  }
}

export function registerEnvironmentCommands(
  program: Command,
  getClient: () => AdminApiClient,
): void {
  const env = program.command('environment').description('Environment management (dual-mode)');

  // ── environment create ──────────────────────────────────────────────────
  env
    .command('create')
    .description('Upsert an environment (idempotent by org+name)')
    .requiredOption('--org <id>', 'Org ID')
    .requiredOption('--name <name>', 'Environment name')
    .option('--type <t>', 'Environment type (fixed|glob|template)', 'fixed')
    .option(
      '--glob-pattern <pattern>',
      'Glob pattern matched against declared environment names (required with --type glob)',
    )
    .option('--enabled <bool>', 'Enabled flag (true|false)', 'true')
    .option('--branch-restrictions <json>', 'JSON array of allowed branches (e.g. \'["main"]\')')
    .option('--required-reviewers <csv>', 'CSV of required reviewer user IDs (or empty to clear)')
    .option('--wait-timer <seconds>', 'Wait timer before release (seconds)')
    .option('--hold-expiry <seconds>', 'Hold expiry TTL (seconds)')
    .option('--minimum-trust <level>', 'Minimum trust (known|trusted)')
    .option('--database-url <url>', 'Use direct DB access instead of HTTP (offline mode)')
    .option('--json', 'Emit JSON output')
    .action(async (opts) => {
      try {
        if (opts.type === 'glob' && !opts.globPattern) {
          throw new Error('--type glob requires --glob-pattern <pattern>');
        }
        if (opts.type !== 'glob' && opts.globPattern !== undefined) {
          throw new Error('--glob-pattern requires --type glob');
        }
        const branchRestrictions = parseJsonOption(
          opts.branchRestrictions,
          '--branch-restrictions',
        ) as string[] | undefined;
        const requiredReviewers = parseCsvOption(opts.requiredReviewers);
        const waitTimerSeconds = parseIntOption(opts.waitTimer, '--wait-timer');
        const holdExpirySeconds = parseIntOption(opts.holdExpiry, '--hold-expiry');
        const enabled = opts.enabled === 'false' ? false : true;
        const payload = {
          orgId: opts.org,
          name: opts.name,
          type: opts.type,
          enabled,
          globPattern: opts.globPattern,
          branchRestrictions,
          requiredReviewers,
          waitTimerSeconds,
          holdExpirySeconds,
          minimumTrust: opts.minimumTrust,
        };
        const dbUrl = resolveDirectDbUrl(opts.databaseUrl);
        const result: SeedEnvironmentResult = dbUrl
          ? await seedEnvironmentDirect(dbUrl, payload)
          : await getClient().post<SeedEnvironmentResult>('/api/v1/admin/environments', payload);
        if (opts.json) {
          console.log(JSON.stringify(result));
        } else {
          console.log(
            `environment create: envId=${result.envId} created=${result.created}${dbUrl ? ' (direct)' : ''}`,
          );
        }
      } catch (err) {
        console.error(`Error: ${toErrorMessage(err)}`);
        process.exit(1);
      }
    });

  // ── environment bind ────────────────────────────────────────────────────
  env
    .command('bind')
    .description('Upsert an environment_bindings row (scope_pattern → environment)')
    .requiredOption('--org <id>', 'Org ID')
    .requiredOption('--env <name>', 'Environment name')
    .requiredOption('--scope <pattern>', 'Scope pattern (e.g. "staging" or "aws/prod/**")')
    .option(
      '--host <pattern>',
      'Host selector (exact/glob/regex over agentId/host/labels); "**" = all hosts',
      '**',
    )
    .option('--database-url <url>', 'Use direct DB access instead of HTTP (offline mode)')
    .option('--json', 'Emit JSON output')
    .action(async (opts) => {
      try {
        const dbUrl = resolveDirectDbUrl(opts.databaseUrl);
        const payload = {
          orgId: opts.org,
          envName: opts.env,
          scopePattern: opts.scope,
          hostPattern: opts.host,
        };
        const result = dbUrl
          ? await seedEnvironmentBindingDirect(dbUrl, payload)
          : await getClient().post<{ created: boolean }>(
              `/api/v1/admin/environments/${encodeURIComponent(opts.env)}/bind`,
              { orgId: opts.org, scopePattern: opts.scope, hostPattern: opts.host },
            );
        if (opts.json) {
          console.log(JSON.stringify(result));
        } else {
          console.log(`environment bind: created=${result.created}${dbUrl ? ' (direct)' : ''}`);
        }
      } catch (err) {
        console.error(`Error: ${toErrorMessage(err)}`);
        process.exit(1);
      }
    });

  // ── environment set-policy ──────────────────────────────────────────────
  env
    .command('set-policy')
    .description('Update policy fields on an environment (only provided fields change)')
    .requiredOption('--org <id>', 'Org ID')
    .requiredOption('--env <name>', 'Environment name')
    .option('--branch-restrictions <json>', 'JSON array of allowed branches')
    .option('--required-reviewers <csv>', 'CSV of required reviewer user IDs (empty to clear)')
    .option('--wait-timer <seconds>', 'Wait timer before release (seconds)')
    .option('--hold-expiry <seconds>', 'Hold expiry TTL (seconds)')
    .option('--minimum-trust <level>', 'Minimum trust (known|trusted, or "null" to clear)')
    .option('--enabled <bool>', 'Enabled flag (true|false)')
    .option(
      '--allow-local-execution <bool>',
      'Allow CLI/test runs to resolve this env (true|false)',
    )
    .option('--database-url <url>', 'Use direct DB access instead of HTTP (offline mode)')
    .option('--json', 'Emit JSON output')
    .action(async (opts) => {
      try {
        const payload: Record<string, unknown> = {
          orgId: opts.org,
          envName: opts.env,
        };
        if (opts.branchRestrictions !== undefined) {
          payload.branchRestrictions = parseJsonOption(
            opts.branchRestrictions,
            '--branch-restrictions',
          );
        }
        if (opts.requiredReviewers !== undefined) {
          payload.requiredReviewers = parseCsvOption(opts.requiredReviewers);
        }
        if (opts.waitTimer !== undefined) {
          payload.waitTimerSeconds = parseIntOption(opts.waitTimer, '--wait-timer');
        }
        if (opts.holdExpiry !== undefined) {
          payload.holdExpirySeconds = parseIntOption(opts.holdExpiry, '--hold-expiry');
        }
        if (opts.minimumTrust !== undefined) {
          payload.minimumTrust = opts.minimumTrust === 'null' ? null : opts.minimumTrust;
        }
        if (opts.enabled !== undefined) {
          payload.enabled = opts.enabled === 'false' ? false : true;
        }
        if (opts.allowLocalExecution !== undefined) {
          payload.allowLocalExecution = opts.allowLocalExecution === 'false' ? false : true;
        }
        const dbUrl = resolveDirectDbUrl(opts.databaseUrl);
        if (dbUrl) {
          await setEnvironmentPolicyDirect(dbUrl, payload as any);
        } else {
          await getClient().patch(
            `/api/v1/admin/environments/${encodeURIComponent(opts.env)}/policy`,
            payload,
          );
        }
        if (opts.json) {
          console.log(JSON.stringify({ updated: true }));
        } else {
          console.log(
            `environment set-policy: updated (env=${opts.env})${dbUrl ? ' (direct)' : ''}`,
          );
        }
      } catch (err) {
        console.error(`Error: ${toErrorMessage(err)}`);
        process.exit(1);
      }
    });

  // ── environment list ────────────────────────────────────────────────────
  env
    .command('list')
    .description('List environments for an org')
    .requiredOption('--org <id>', 'Org ID')
    .option('--database-url <url>', 'Use direct DB access instead of HTTP (offline mode)')
    .option('--json', 'Emit JSON output')
    .action(async (opts) => {
      try {
        const dbUrl = resolveDirectDbUrl(opts.databaseUrl);
        const result = dbUrl
          ? await listEnvironmentsDirect(dbUrl, { orgId: opts.org })
          : await getClient().get<{ environments: EnvironmentRow[] }>(
              `/api/v1/admin/environments?orgId=${encodeURIComponent(opts.org)}`,
            );
        if (opts.json) {
          console.log(JSON.stringify(result));
        } else {
          printEnvironmentTable(result.environments);
        }
      } catch (err) {
        console.error(`Error: ${toErrorMessage(err)}`);
        process.exit(1);
      }
    });

  // ── environment show ────────────────────────────────────────────────────
  env
    .command('show')
    .description('Show a single environment with variables + bindings')
    .requiredOption('--org <id>', 'Org ID')
    .requiredOption('--name <name>', 'Environment name')
    .option('--database-url <url>', 'Use direct DB access instead of HTTP (offline mode)')
    .option('--json', 'Emit JSON output')
    .action(async (opts) => {
      try {
        const dbUrl = resolveDirectDbUrl(opts.databaseUrl);
        const result = dbUrl
          ? await showEnvironmentDirect(dbUrl, { orgId: opts.org, name: opts.name })
          : await getClient().get<ShowEnvironmentResult>(
              `/api/v1/admin/environments/${encodeURIComponent(opts.name)}?orgId=${encodeURIComponent(opts.org)}`,
            );
        if (opts.json) {
          console.log(JSON.stringify(result));
        } else {
          printShowEnvironment(result);
        }
      } catch (err) {
        console.error(`Error: ${toErrorMessage(err)}`);
        process.exit(1);
      }
    });

  // ── environment delete ──────────────────────────────────────────────────
  env
    .command('delete')
    .description(
      'Delete an environment (cascades bindings, variables, overrides; held-run history survives; pending held runs block with a clear error, resolved holds do not)',
    )
    .requiredOption('--org <id>', 'Org ID')
    .requiredOption('--name <name>', 'Environment name')
    .option('--database-url <url>', 'Use direct DB access instead of HTTP (offline mode)')
    .option('--json', 'Emit JSON output')
    .action(async (opts) => {
      try {
        const dbUrl = resolveDirectDbUrl(opts.databaseUrl);
        let deleted: boolean;
        if (dbUrl) {
          ({ deleted } = await deleteEnvironmentDirect(dbUrl, {
            orgId: opts.org,
            name: opts.name,
          }));
        } else {
          const res = await getClient().delete<{ deleted: boolean }>(
            `/api/v1/admin/environments/${encodeURIComponent(opts.name)}?orgId=${encodeURIComponent(opts.org)}`,
          );
          deleted = res.deleted;
        }
        if (!deleted) throw new Error(`environment not found (org=${opts.org}, name=${opts.name})`);
        if (opts.json) {
          console.log(JSON.stringify({ deleted: true }));
        } else {
          console.log(`environment delete: deleted=true${dbUrl ? ' (direct)' : ''}`);
        }
      } catch (err) {
        console.error(`Error: ${toErrorMessage(err)}`);
        process.exit(1);
      }
    });

  // ── environment create-template ─────────────────────────────────────────
  env
    .command('create-template')
    .description('Create or update an environment template + its seed variables')
    .requiredOption('--org <id>', 'Org ID')
    .requiredOption('--template <name>', 'Template name')
    .option('--type <t>', 'Environment type (defaults to "template")', 'template')
    .option('--branch-restrictions <json>', 'JSON array of allowed branches')
    .option('--required-reviewers <csv>', 'CSV of required reviewer user IDs')
    .option('--wait-timer <seconds>', 'Wait timer (seconds)')
    .option('--hold-expiry <seconds>', 'Hold expiry TTL (seconds)')
    .option('--minimum-trust <level>', 'Minimum trust (known|trusted)')
    .option('--variables <json>', 'JSON object of env variables to seed (e.g. \'{"K":"V"}\')')
    .option('--database-url <url>', 'Use direct DB access instead of HTTP (offline mode)')
    .option('--json', 'Emit JSON output')
    .action(async (opts) => {
      try {
        const branchRestrictions = parseJsonOption(
          opts.branchRestrictions,
          '--branch-restrictions',
        );
        const requiredReviewers = parseCsvOption(opts.requiredReviewers);
        const waitTimerSeconds = parseIntOption(opts.waitTimer, '--wait-timer');
        const holdExpirySeconds = parseIntOption(opts.holdExpiry, '--hold-expiry');
        const variables = parseJsonOption(opts.variables, '--variables') as
          | Record<string, string>
          | undefined;
        if (
          variables !== undefined &&
          (typeof variables !== 'object' || Array.isArray(variables))
        ) {
          throw new Error('--variables: must be a JSON object of string values');
        }
        const payload = {
          orgId: opts.org,
          templateName: opts.template,
          type: opts.type,
          branchRestrictions,
          requiredReviewers,
          waitTimerSeconds,
          holdExpirySeconds,
          minimumTrust: opts.minimumTrust,
          variables,
        };
        const dbUrl = resolveDirectDbUrl(opts.databaseUrl);
        const result = dbUrl
          ? await createEnvironmentTemplateDirect(dbUrl, payload)
          : await getClient().post<{ envId: string; created: boolean; variablesSet: number }>(
              '/api/v1/admin/environments/templates',
              payload,
            );
        if (opts.json) {
          console.log(JSON.stringify(result));
        } else {
          console.log(
            `environment create-template: envId=${result.envId} created=${result.created} variablesSet=${result.variablesSet}${dbUrl ? ' (direct)' : ''}`,
          );
        }
      } catch (err) {
        console.error(`Error: ${toErrorMessage(err)}`);
        process.exit(1);
      }
    });
}

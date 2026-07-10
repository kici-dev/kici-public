/**
 * Context management CLI commands for kici-admin.
 *
 *   context create         — upsert a context
 *   context bind           — bind a scope pattern to a context
 *   context set-policy     — update policy fields (branch, reviewers, timers, trust)
 *   context list           — list contexts for an org
 *   context show           — show a single context with variables + bindings
 *   context delete         — delete a context (cascades bindings, variables, overrides; held-run history survives; pending held runs block with a clear error, resolved holds do not)
 *   context create-template — create/update a context template + its seed variables
 *
 * Each command supports two modes (stage-4 pattern from `maintenance.ts`):
 *
 *   HTTP mode (default): requires `--url` + `--token`, routes through the
 *   orchestrator admin HTTP API at /api/v1/admin/contexts.
 *
 *   Direct-DB mode: activated when `--database-url` is passed (or
 *   KICI_DATABASE_URL / DATABASE_URL is set). Opens its own pool and runs the
 *   SQL directly via *Direct helpers in @kici-dev/shared. Used by E2E
 *   `globalSetup` helpers that need to seed envs before the orchestrator is up.
 */
import type { Command } from 'commander';
import {
  createContextTemplateDirect,
  deleteContextDirect,
  purgeContextsDirect,
  listContextsDirect,
  seedContextBindingDirect,
  seedContextDirect,
  setContextPolicyDirect,
  showContextDirect,
  toErrorMessage,
} from '@kici-dev/shared';
import type { ContextRow, ShowContextResult, SeedContextResult } from '@kici-dev/shared';
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
function summarizePolicy(env: ContextRow): string {
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

function printContextTable(rows: ContextRow[]): void {
  if (rows.length === 0) {
    console.log('No contexts found.');
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

function printShowContext(res: ShowContextResult): void {
  const e = res.context;
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

export function registerContextCommands(program: Command, getClient: () => AdminApiClient): void {
  const env = program.command('context').description('Context management (dual-mode)');

  // ── context create ──────────────────────────────────────────────────
  env
    .command('create')
    .description('Upsert a context (idempotent by org+name)')
    .requiredOption('--org <id>', 'Org ID')
    .requiredOption('--name <name>', 'Context name')
    .option('--type <t>', 'Context type (fixed|glob|template)', 'fixed')
    .option(
      '--glob-pattern <pattern>',
      'Glob pattern matched against declared context names (required with --type glob)',
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
        const result: SeedContextResult = dbUrl
          ? await seedContextDirect(dbUrl, payload)
          : await getClient().post<SeedContextResult>('/api/v1/admin/contexts', payload);
        if (opts.json) {
          console.log(JSON.stringify(result));
        } else {
          console.log(
            `context create: envId=${result.envId} created=${result.created}${dbUrl ? ' (direct)' : ''}`,
          );
        }
      } catch (err) {
        console.error(`Error: ${toErrorMessage(err)}`);
        process.exit(1);
      }
    });

  // ── context bind ────────────────────────────────────────────────────
  env
    .command('bind')
    .description('Upsert a context_bindings row (scope_pattern → context)')
    .requiredOption('--org <id>', 'Org ID')
    .requiredOption('--env <name>', 'Context name')
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
          contextName: opts.env,
          scopePattern: opts.scope,
          hostPattern: opts.host,
        };
        const result = dbUrl
          ? await seedContextBindingDirect(dbUrl, payload)
          : await getClient().post<{ created: boolean }>(
              `/api/v1/admin/contexts/${encodeURIComponent(opts.env)}/bind`,
              { orgId: opts.org, scopePattern: opts.scope, hostPattern: opts.host },
            );
        if (opts.json) {
          console.log(JSON.stringify(result));
        } else {
          console.log(`context bind: created=${result.created}${dbUrl ? ' (direct)' : ''}`);
        }
      } catch (err) {
        console.error(`Error: ${toErrorMessage(err)}`);
        process.exit(1);
      }
    });

  // ── context set-policy ──────────────────────────────────────────────
  env
    .command('set-policy')
    .description('Update policy fields on a context (only provided fields change)')
    .requiredOption('--org <id>', 'Org ID')
    .requiredOption('--env <name>', 'Context name')
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
          contextName: opts.env,
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
          await setContextPolicyDirect(dbUrl, payload as any);
        } else {
          await getClient().patch(
            `/api/v1/admin/contexts/${encodeURIComponent(opts.env)}/policy`,
            payload,
          );
        }
        if (opts.json) {
          console.log(JSON.stringify({ updated: true }));
        } else {
          console.log(`context set-policy: updated (env=${opts.env})${dbUrl ? ' (direct)' : ''}`);
        }
      } catch (err) {
        console.error(`Error: ${toErrorMessage(err)}`);
        process.exit(1);
      }
    });

  // ── context list ────────────────────────────────────────────────────
  env
    .command('list')
    .description('List contexts for an org')
    .requiredOption('--org <id>', 'Org ID')
    .option('--database-url <url>', 'Use direct DB access instead of HTTP (offline mode)')
    .option('--json', 'Emit JSON output')
    .action(async (opts) => {
      try {
        const dbUrl = resolveDirectDbUrl(opts.databaseUrl);
        const result = dbUrl
          ? await listContextsDirect(dbUrl, { orgId: opts.org })
          : await getClient().get<{ contexts: ContextRow[] }>(
              `/api/v1/admin/contexts?orgId=${encodeURIComponent(opts.org)}`,
            );
        if (opts.json) {
          console.log(JSON.stringify(result));
        } else {
          printContextTable(result.contexts);
        }
      } catch (err) {
        console.error(`Error: ${toErrorMessage(err)}`);
        process.exit(1);
      }
    });

  // ── context show ────────────────────────────────────────────────────
  env
    .command('show')
    .description('Show a single context with variables + bindings')
    .requiredOption('--org <id>', 'Org ID')
    .requiredOption('--name <name>', 'Context name')
    .option('--database-url <url>', 'Use direct DB access instead of HTTP (offline mode)')
    .option('--json', 'Emit JSON output')
    .action(async (opts) => {
      try {
        const dbUrl = resolveDirectDbUrl(opts.databaseUrl);
        const result = dbUrl
          ? await showContextDirect(dbUrl, { orgId: opts.org, name: opts.name })
          : await getClient().get<ShowContextResult>(
              `/api/v1/admin/contexts/${encodeURIComponent(opts.name)}?orgId=${encodeURIComponent(opts.org)}`,
            );
        if (opts.json) {
          console.log(JSON.stringify(result));
        } else {
          printShowContext(result);
        }
      } catch (err) {
        console.error(`Error: ${toErrorMessage(err)}`);
        process.exit(1);
      }
    });

  // ── context delete ──────────────────────────────────────────────────
  env
    .command('delete')
    .description(
      'Delete a context (cascades bindings, variables, overrides; held-run history survives; pending held runs block with a clear error, resolved holds do not)',
    )
    .requiredOption('--org <id>', 'Org ID')
    .requiredOption('--name <name>', 'Context name')
    .option('--database-url <url>', 'Use direct DB access instead of HTTP (offline mode)')
    .option('--json', 'Emit JSON output')
    .action(async (opts) => {
      try {
        const dbUrl = resolveDirectDbUrl(opts.databaseUrl);
        let deleted: boolean;
        if (dbUrl) {
          ({ deleted } = await deleteContextDirect(dbUrl, {
            orgId: opts.org,
            name: opts.name,
          }));
        } else {
          const res = await getClient().delete<{ deleted: boolean }>(
            `/api/v1/admin/contexts/${encodeURIComponent(opts.name)}?orgId=${encodeURIComponent(opts.org)}`,
          );
          deleted = res.deleted;
        }
        if (!deleted) throw new Error(`context not found (org=${opts.org}, name=${opts.name})`);
        if (opts.json) {
          console.log(JSON.stringify({ deleted: true }));
        } else {
          console.log(`context delete: deleted=true${dbUrl ? ' (direct)' : ''}`);
        }
      } catch (err) {
        console.error(`Error: ${toErrorMessage(err)}`);
        process.exit(1);
      }
    });

  // ── context purge ───────────────────────────────────────────────────
  env
    .command('purge')
    .description(
      'Delete all contexts (and held runs) for an org — direct-DB break-glass / warm-start reset',
    )
    .option('--database-url <url>', 'Use direct DB access (or KICI_DATABASE_URL)')
    .option('--org <id>', 'Restrict purge to a single org (omit to purge all orgs)')
    .option('--json', 'Emit JSON output')
    .action(async (opts) => {
      try {
        const dbUrl = resolveDirectDbUrl(opts.databaseUrl);
        if (!dbUrl) {
          console.error('Error: --database-url or KICI_DATABASE_URL is required (direct-DB only)');
          process.exit(1);
        }
        const result = await purgeContextsDirect(dbUrl, opts.org);
        if (opts.json) {
          console.log(JSON.stringify(result));
        } else {
          console.log(
            `context purge: contextsDeleted=${result.contextsDeleted} heldRunsDeleted=${result.heldRunsDeleted}` +
              (opts.org ? ` (org ${opts.org})` : ' (all orgs)'),
          );
        }
      } catch (err) {
        console.error(`Error: ${toErrorMessage(err)}`);
        process.exit(1);
      }
    });

  // ── context create-template ─────────────────────────────────────────
  env
    .command('create-template')
    .description('Create or update a context template + its seed variables')
    .requiredOption('--org <id>', 'Org ID')
    .requiredOption('--template <name>', 'Template name')
    .option('--type <t>', 'Context type (defaults to "template")', 'template')
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
          ? await createContextTemplateDirect(dbUrl, payload)
          : await getClient().post<{ envId: string; created: boolean; variablesSet: number }>(
              '/api/v1/admin/contexts/templates',
              payload,
            );
        if (opts.json) {
          console.log(JSON.stringify(result));
        } else {
          console.log(
            `context create-template: envId=${result.envId} created=${result.created} variablesSet=${result.variablesSet}${dbUrl ? ' (direct)' : ''}`,
          );
        }
      } catch (err) {
        console.error(`Error: ${toErrorMessage(err)}`);
        process.exit(1);
      }
    });
}

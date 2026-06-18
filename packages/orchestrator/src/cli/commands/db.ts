/**
 * Database management commands for kici-admin.
 *
 *   db migrate                    Run pending migrations (HTTP — orchestrator must be up)
 *   db fresh                      DROP + CREATE + migrate + store content hash (direct DB)
 *   db ensure <name>              CREATE DATABASE IF NOT EXISTS (direct DB)
 *   db create-role                CREATE ROLE LOGIN [CREATEDB] (direct DB)
 *   db create-readonly-user       Read-only role + GRANT SELECT (direct DB)
 *   db check-schema               Compare bundled migrations vs live schema (direct DB)
 *   db collation-check            Check pg_database.datcollversion vs running libc (direct DB)
 *   db reindex                    REINDEX DATABASE CONCURRENTLY (direct DB)
 *   db refresh-collation-version  ALTER DATABASE REFRESH COLLATION VERSION (direct DB)
 *
 * The direct-DB subcommands cannot go through HTTP because the target database
 * may not exist yet or is about to be dropped. They follow the same pattern
 * as `kici-admin peer create-token` — open a pool from KICI_DATABASE_URL /
 * DATABASE_URL / --database-url.
 */

import os from 'node:os';
import { createInterface } from 'node:readline';
import type { Command } from 'commander';
import type { AdminApiClient } from '../api-client.js';
import {
  computeMigrationsHash,
  createDbRole,
  createPool,
  createReadOnlyDbUser,
  dropAndCreateDatabase,
  ensureDatabase,
  isSchemaCurrent,
  maskDatabaseUrl,
  parseDatabaseUrl,
  toErrorMessage,
} from '@kici-dev/shared';
import {
  getDatabaseCollationDrift,
  refreshDatabaseCollationVersion,
  reindexDatabaseConcurrently,
} from '@kici-dev/shared/db-collation';
import { createDb } from '../../db/client.js';
import { createMigrationProvider } from '../../db/migration-provider.js';
import { runMigrations } from '../../db/migrator.js';

function resolveDatabaseUrl(explicit?: string): string {
  const url = explicit ?? process.env.KICI_DATABASE_URL;
  if (!url) {
    throw new Error('Database URL required. Pass --database-url or set KICI_DATABASE_URL.');
  }
  return url;
}

async function confirmInteractive(prompt: string, expected: string): Promise<boolean> {
  if (!process.stdin.isTTY) return false;
  process.stderr.write(prompt);
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    const answer = await new Promise<string>((resolve) => rl.once('line', resolve));
    return answer.trim() === expected;
  } finally {
    rl.close();
  }
}

function logInvocation(action: string, url: string): void {
  process.stderr.write(`kici-admin db ${action} @${os.hostname()}: ${maskDatabaseUrl(url)}\n`);
}

export function registerDbCommands(program: Command, getClient: () => AdminApiClient): void {
  const db = program.command('db').description('Database management');

  db.command('migrate')
    .description('Run pending database migrations (via orchestrator HTTP admin API)')
    .option('--status', 'Show migration status without applying')
    .action(async (opts: { status?: boolean }) => {
      try {
        if (opts.status) {
          const result = await getClient().get<{
            migrations: Array<{ name: string; status: string; appliedAt?: string }>;
          }>('/api/v1/admin/db/migrate/status');
          for (const m of result.migrations) {
            const marker = m.status === 'applied' ? 'OK' : 'PENDING';
            const date = m.appliedAt ? new Date(m.appliedAt).toISOString() : '-';
            console.log(`  ${marker.padEnd(8)} ${m.name.padEnd(50)} ${date}`);
          }
        } else {
          const result = await getClient().post<{
            applied: number;
            migrations: string[];
          }>('/api/v1/admin/db/migrate', {});
          if (result.applied === 0) {
            console.log('Database schema is up to date.');
          } else {
            console.log(`Applied ${result.applied} migration(s).`);
            for (const name of result.migrations) {
              console.log(`  OK  ${name}`);
            }
          }
        }
      } catch (err) {
        console.error(`Error: ${toErrorMessage(err)}`);
        process.exit(1);
      }
    });

  db.command('fresh')
    .description('DROP + CREATE the orchestrator DB, run migrations, record content hash')
    .option('--database-url <url>', 'Target database URL (else KICI_DATABASE_URL / DATABASE_URL)')
    .requiredOption('--confirm', 'Explicit confirmation (destructive)')
    .option('--yes', 'Skip interactive confirmation (for scripted use)')
    .action(async (opts: { databaseUrl?: string; yes?: boolean }) => {
      try {
        const url = resolveDatabaseUrl(opts.databaseUrl);
        const { dbName } = parseDatabaseUrl(url);
        if (!opts.yes) {
          const ok = await confirmInteractive(
            `About to DROP + RECREATE database "${dbName}". Type "${dbName}" to confirm: `,
            dbName,
          );
          if (!ok) {
            console.error('Aborted.');
            process.exit(1);
          }
        }
        logInvocation('fresh', url);
        await dropAndCreateDatabase(url);
        process.stderr.write('  dropped + recreated\n');

        const pool = createPool(url);
        const kdb = createDb(pool);
        try {
          const results = await runMigrations({ db: kdb, pool });
          const applied = results.filter((r) => r.status === 'Success').length;
          // runMigrations records the content hash; recompute only for display.
          const hash = await computeMigrationsHash(createMigrationProvider());
          console.log(
            `db fresh: ${dbName} — applied ${applied} migration(s), content hash ${hash.slice(0, 12)}...`,
          );
        } finally {
          await kdb.destroy();
          await pool.end().catch(() => undefined);
        }
      } catch (err) {
        console.error(`Error: ${toErrorMessage(err)}`);
        process.exit(1);
      }
    });

  db.command('ensure <name>')
    .description('CREATE DATABASE IF NOT EXISTS (idempotent)')
    .option('--database-url <url>', 'Admin DB URL (else KICI_DATABASE_URL / DATABASE_URL)')
    .option(
      '--owner <role>',
      'DB owner role (default: URL user). Pass when the admin connection is privileged but the new DB should be owned by a separate non-privileged role.',
    )
    .option(
      '--revoke-connect-public',
      'After ensure, REVOKE CONNECT ON DATABASE "<name>" FROM PUBLIC (recommended on shared clusters).',
    )
    .option(
      '--grant-connect-role <role>',
      'After ensure (and any --revoke-connect-public), GRANT CONNECT ON DATABASE "<name>" TO "<role>". Repeatable.',
      (val: string, acc: string[]) => acc.concat([val]),
      [] as string[],
    )
    .action(
      async (
        name: string,
        opts: {
          databaseUrl?: string;
          owner?: string;
          revokeConnectPublic?: boolean;
          grantConnectRole: string[];
        },
      ) => {
        try {
          const baseUrl = resolveDatabaseUrl(opts.databaseUrl);
          const url = new URL(baseUrl);
          url.pathname = `/${name}`;
          const targetUrl = url.toString();
          logInvocation(`ensure ${name}`, targetUrl);
          const outcome = await ensureDatabase(targetUrl, {
            owner: opts.owner,
            revokeConnectFromPublic: !!opts.revokeConnectPublic,
            grantConnectToRoles: opts.grantConnectRole,
          });
          const suffix =
            (opts.owner ? ` (owner=${opts.owner})` : '') +
            (opts.revokeConnectPublic ? ' [revoked CONNECT from PUBLIC]' : '') +
            (opts.grantConnectRole.length
              ? ` [granted CONNECT to: ${opts.grantConnectRole.join(', ')}]`
              : '');
          console.log(`db ensure: ${name} — ${outcome}${suffix}`);
        } catch (err) {
          console.error(`Error: ${toErrorMessage(err)}`);
          process.exit(1);
        }
      },
    );

  db.command('create-role')
    .description('CREATE / ALTER ROLE with LOGIN [+ CREATEDB] (idempotent)')
    .option('--database-url <url>', 'Admin DB URL (else KICI_DATABASE_URL / DATABASE_URL)')
    .requiredOption('--user <name>', 'Role name to create or update')
    .requiredOption('--password <password>', 'Role password (raw — quote as needed)')
    .option('--createdb', 'Grant CREATEDB to the new role', false)
    .action(
      async (opts: {
        databaseUrl?: string;
        user: string;
        password: string;
        createdb?: boolean;
      }) => {
        try {
          const url = resolveDatabaseUrl(opts.databaseUrl);
          const { adminUrl } = parseDatabaseUrl(url);
          logInvocation(`create-role ${opts.user}`, adminUrl);
          const outcome = await createDbRole(adminUrl, {
            username: opts.user,
            password: opts.password,
            createDb: !!opts.createdb,
          });
          console.log(`db create-role: ${opts.user} — ${outcome}`);
        } catch (err) {
          console.error(`Error: ${toErrorMessage(err)}`);
          process.exit(1);
        }
      },
    );

  db.command('create-readonly-user')
    .description('Create a read-only role with SELECT on all tables + default privileges')
    .option('--database-url <url>', 'Target DB URL (must connect as owner)')
    .requiredOption('--user <name>', 'Read-only role name')
    .requiredOption('--password <password>', 'Role password')
    .action(async (opts: { databaseUrl?: string; user: string; password: string }) => {
      try {
        const url = resolveDatabaseUrl(opts.databaseUrl);
        const { dbName } = parseDatabaseUrl(url);
        logInvocation(`create-readonly-user ${opts.user}`, url);
        const outcome = await createReadOnlyDbUser(url, {
          username: opts.user,
          password: opts.password,
        });
        console.log(`db create-readonly-user: ${opts.user} — ${outcome} (db=${dbName})`);
      } catch (err) {
        console.error(`Error: ${toErrorMessage(err)}`);
        process.exit(1);
      }
    });

  db.command('check-schema')
    .description('Compare bundled migrations vs live schema. Exit 2 on drift.')
    .option('--database-url <url>', 'Target DB URL (else KICI_DATABASE_URL / DATABASE_URL)')
    .option('--json', 'Emit JSON instead of a human-readable line', false)
    .action(async (opts: { databaseUrl?: string; json?: boolean }) => {
      try {
        const url = resolveDatabaseUrl(opts.databaseUrl);
        const pool = createPool(url);
        try {
          const status = await isSchemaCurrent(pool, createMigrationProvider());
          if (opts.json) {
            process.stdout.write(JSON.stringify(status) + '\n');
          } else if (status.current) {
            console.log('schema is current');
          } else {
            console.log(`schema drift: ${status.reason}`);
          }
          if (!status.current) process.exit(2);
        } finally {
          await pool.end().catch(() => undefined);
        }
      } catch (err) {
        console.error(`Error: ${toErrorMessage(err)}`);
        process.exit(1);
      }
    });

  db.command('collation-check')
    .description(
      'Compare pg_database.datcollversion against the running libc collation version. Exit 2 on drift.',
    )
    .option('--database-url <url>', 'Target DB URL (else KICI_DATABASE_URL / DATABASE_URL)')
    .option('--json', 'Emit JSON instead of a human-readable line', false)
    .action(async (opts: { databaseUrl?: string; json?: boolean }) => {
      try {
        const url = resolveDatabaseUrl(opts.databaseUrl);
        const { dbName } = parseDatabaseUrl(url);
        const pool = createPool(url);
        try {
          const drift = await getDatabaseCollationDrift(pool, dbName);
          if (drift) {
            if (opts.json) {
              process.stdout.write(
                JSON.stringify({
                  clean: false,
                  database: dbName,
                  stamped: drift.stamped,
                  actual: drift.actual,
                }) + '\n',
              );
            } else {
              console.log(
                `db collation-check: ${dbName} — drift: stamped=${drift.stamped} actual=${drift.actual}`,
              );
            }
            process.exit(2);
          }
          if (opts.json) {
            process.stdout.write(JSON.stringify({ clean: true, database: dbName }) + '\n');
          } else {
            console.log(`db collation-check: ${dbName} — clean`);
          }
        } finally {
          await pool.end().catch(() => undefined);
        }
      } catch (err) {
        console.error(`Error: ${toErrorMessage(err)}`);
        process.exit(1);
      }
    });

  db.command('reindex')
    .description(
      'REINDEX DATABASE CONCURRENTLY <db>. Rebuilds every index under the running libc collation rules. Non-blocking but takes minutes + ~2× temp disk.',
    )
    .option('--database-url <url>', 'Target DB URL (else KICI_DATABASE_URL / DATABASE_URL)')
    .requiredOption('--confirm', 'Explicit confirmation (destructive — long-running)')
    .requiredOption('--reason <text>', 'Reason (recorded in stderr banner)')
    .action(async (opts: { databaseUrl?: string; reason: string }) => {
      try {
        const url = resolveDatabaseUrl(opts.databaseUrl);
        const { dbName } = parseDatabaseUrl(url);
        logInvocation(`reindex ${dbName} (${opts.reason})`, url);
        const pool = createPool(url);
        try {
          await reindexDatabaseConcurrently(pool, dbName);
          console.log(`db reindex: ${dbName} — REINDEX DATABASE CONCURRENTLY completed`);
        } finally {
          await pool.end().catch(() => undefined);
        }
      } catch (err) {
        console.error(`Error: ${toErrorMessage(err)}`);
        process.exit(1);
      }
    });

  db.command('refresh-collation-version')
    .description(
      'ALTER DATABASE <db> REFRESH COLLATION VERSION. Metadata-only bump; pair with db reindex after a libc-base image rebuild.',
    )
    .option('--database-url <url>', 'Target DB URL (else KICI_DATABASE_URL / DATABASE_URL)')
    .requiredOption('--reason <text>', 'Reason (recorded in stderr banner)')
    .action(async (opts: { databaseUrl?: string; reason: string }) => {
      try {
        const url = resolveDatabaseUrl(opts.databaseUrl);
        const { dbName } = parseDatabaseUrl(url);
        logInvocation(`refresh-collation-version ${dbName} (${opts.reason})`, url);
        const pool = createPool(url);
        try {
          await refreshDatabaseCollationVersion(pool, dbName);
          console.log(
            `db refresh-collation-version: ${dbName} — ALTER DATABASE REFRESH COLLATION VERSION completed`,
          );
        } finally {
          await pool.end().catch(() => undefined);
        }
      } catch (err) {
        console.error(`Error: ${toErrorMessage(err)}`);
        process.exit(1);
      }
    });
}

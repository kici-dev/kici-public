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
import path from 'node:path';
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
import { recordAdminCliAccess, recordAdminCliAccessOnDb } from './shared/admin-cli-access-log.js';
import {
  assertToolVersionCompatible,
  createDbBackup,
  defaultDumpPath,
  dumpPathIn,
  pgToolVersion,
  pruneBackupDir,
  readManifest,
  restoreKeyWarning,
  runPgRestore,
  serverVersionMajor,
} from './db-backup.js';
import {
  BACKUP_TIMER_DEFAULT_KEEP,
  BACKUP_TIMER_DEFAULT_SCHEDULE,
  installBackupTimer,
  uninstallBackupTimer,
} from '../service/backup-timer.js';
import { kiciConfigRoot, resolveInstanceTarget, resolveUserLevel } from '../service/index.js';
import type { ServicePlatform } from '../service/index.js';

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

interface BackupOptions {
  databaseUrl?: string;
  output?: string;
  outputDir?: string;
  keep: string;
  installTimer?: boolean;
  uninstallTimer?: boolean;
  schedule: string;
  platform?: ServicePlatform;
  instanceDir?: string;
  name?: string;
  system?: boolean;
  userLevel?: boolean;
}

function parseKeep(raw: string): number {
  const keep = Number.parseInt(raw, 10);
  if (!Number.isFinite(keep) || keep < 1) {
    throw new Error(`--keep must be a positive integer, got "${raw}".`);
  }
  return keep;
}

/** `kici-admin db backup` — take one dump, optionally pruning a retention dir. */
async function runBackupCommand(opts: BackupOptions): Promise<void> {
  const url = resolveDatabaseUrl(opts.databaseUrl);
  const now = new Date();
  const outputPath =
    opts.output ?? (opts.outputDir ? dumpPathIn(opts.outputDir, now) : defaultDumpPath(now));
  logInvocation('backup', url);

  const pool = createPool(url);
  const kdb = createDb(pool);
  try {
    const result = await createDbBackup({
      databaseUrl: url,
      outputPath,
      db: kdb,
      pool,
      now,
    });

    console.log(
      `db backup: wrote ${result.outputPath} (${result.byteSize} bytes) + ${result.outputPath}.manifest.json`,
    );
    if (opts.outputDir) {
      const removed = await pruneBackupDir(opts.outputDir, parseKeep(opts.keep));
      if (removed.length > 0) {
        console.log(`db backup: pruned ${removed.length} file(s) from ${opts.outputDir}`);
      }
    }
    console.error(
      '\n  IMPORTANT: this dump contains ENCRYPTED secret ciphertext only.\n' +
        '  It is useless without the separately-held KICI_SECRET_KEY, which is NOT in the dump.\n' +
        `  Back up KICI_SECRET_KEY separately (this dump is under key generation ${result.manifest.secretKeyVersion ?? 'n/a'}).\n`,
    );
  } finally {
    await kdb.destroy();
    await pool.end().catch(() => undefined);
  }
}

/** `kici-admin db backup --install-timer` / `--uninstall-timer`. */
async function runBackupTimerCommand(opts: BackupOptions): Promise<void> {
  if (opts.installTimer && opts.uninstallTimer) {
    throw new Error('`--install-timer` and `--uninstall-timer` are mutually exclusive.');
  }
  const userLevel = resolveUserLevel(opts);
  // The timer is written for the install, so its platform is the install's, not
  // the host's: a compose orchestrator on a systemd box must hit the compose
  // refusal rather than get a systemd unit pointed at a container.
  const { resolved, platform } = await resolveInstanceTarget({
    component: 'orchestrator',
    opts: { instanceDir: opts.instanceDir, name: opts.name },
    cwd: process.cwd(),
    kiciRoot: kiciConfigRoot(userLevel),
    platformOverride: opts.platform,
    isUserLevel: userLevel,
  });

  const keep = parseKeep(opts.keep);
  const outputDir = opts.outputDir ?? path.join(resolved.instanceDir, 'backups');

  if (opts.uninstallTimer) {
    const removed = uninstallBackupTimer(platform, {
      serviceName: resolved.manifest.name,
      isUserLevel: resolved.manifest.isUserLevel,
      outputDir,
      keep,
    });
    console.log(`db backup: removed scheduled backup "${removed.unitName}".`);
    for (const file of removed.files) console.log(`  ${file}`);
    return;
  }

  const installed = installBackupTimer(platform, {
    serviceName: resolved.manifest.name,
    schedule: opts.schedule,
    outputDir,
    keep,
    nodeBinPath: process.execPath,
    cliScriptPath: process.argv[1] ?? 'kici-admin',
    envFilePath: resolved.manifest.envFilePath,
    isUserLevel: resolved.manifest.isUserLevel,
  });
  console.log(`db backup: installed scheduled backup "${installed.unitName}".`);
  console.log(`  Schedule:  ${opts.schedule}`);
  console.log(`  Dumps:     ${outputDir} (keeping the newest ${keep})`);
  for (const file of installed.files) console.log(`  Unit:      ${file}`);
}

export function registerDbCommands(program: Command, getClient: () => AdminApiClient): void {
  const db = program.command('db').description('Database management');

  db.command('migrate')
    .description('Run pending database migrations (via orchestrator HTTP admin API)')
    .option('--status', 'Show migration status without applying')
    .option(
      '--to <migration>',
      'Migrate to a named migration, reverting newer ones. Run this BEFORE a rollback, ' +
        'while the newer binary is still serving — it is the only one carrying their down() functions.',
    )
    .action(async (opts: { status?: boolean; to?: string }) => {
      try {
        if (opts.to) {
          const result = await getClient().post<{
            target: string;
            applied: string[];
            reverted: string[];
          }>('/api/v1/admin/db/migrate/to', { name: opts.to });
          for (const name of result.reverted) console.log(`  REVERTED  ${name}`);
          for (const name of result.applied) console.log(`  OK        ${name}`);
          console.log(
            result.reverted.length === 0 && result.applied.length === 0
              ? `Database is already at ${result.target}.`
              : `Database is now at ${result.target}.`,
          );
        } else if (opts.status) {
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
          await recordAdminCliAccessOnDb(kdb, {
            action: 'db.fresh',
            target: { type: 'database', id: dbName },
            outcome: 'allowed',
            meta: { applied },
          });
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

  db.command('backup')
    .description('Dump the orchestrator DB to a local file (pg_dump custom format)')
    .option('--database-url <url>', 'Source DB URL (else KICI_DATABASE_URL / DATABASE_URL)')
    .option('--output <path>', 'Dump output path (default ./kici-orchestrator-backup-<ts>.dump)')
    .option(
      '--output-dir <path>',
      'Write a timestamped dump into this directory, then prune it to --keep dumps',
    )
    .option(
      '--keep <n>',
      `Dumps to retain in --output-dir (default ${BACKUP_TIMER_DEFAULT_KEEP})`,
      `${BACKUP_TIMER_DEFAULT_KEEP}`,
    )
    .option('--install-timer', 'Install a scheduled backup service + timer and exit')
    .option('--uninstall-timer', 'Remove the scheduled backup service + timer and exit')
    .option(
      '--schedule <spec>',
      `Timer calendar spec: a systemd OnCalendar value, or daily / HH:MM (default ${BACKUP_TIMER_DEFAULT_SCHEDULE})`,
      BACKUP_TIMER_DEFAULT_SCHEDULE,
    )
    .option(
      '--platform <type>',
      'Force the service platform (systemd, launchd, windows, compose). Default: the platform in the install manifest',
    )
    .option('--instance-dir <path>', 'Deploy folder of the orchestrator instance to schedule')
    .option('--name <name>', 'Orchestrator service name to schedule (no default)')
    .option('--system', 'Operate against the system-level timer (requires root)')
    .option('--user-level', 'Operate against the user-level timer')
    .action(async (opts: BackupOptions) => {
      try {
        if (opts.installTimer || opts.uninstallTimer) {
          await runBackupTimerCommand(opts);
          return;
        }
        await runBackupCommand(opts);
      } catch (err) {
        console.error(`Error: ${toErrorMessage(err)}`);
        process.exit(1);
      }
    });

  db.command('restore')
    .description('Restore the orchestrator DB from a pg_dump file (DESTRUCTIVE)')
    .requiredOption('--input <path>', 'Path to a .dump file produced by `db backup`')
    .option('--database-url <url>', 'Target DB URL (else KICI_DATABASE_URL / DATABASE_URL)')
    .option('--yes', 'Skip interactive confirmation (for scripted use)')
    .action(async (opts: { input: string; databaseUrl?: string; yes?: boolean }) => {
      try {
        const url = resolveDatabaseUrl(opts.databaseUrl);
        const { dbName } = parseDatabaseUrl(url);
        if (!opts.yes) {
          const ok = await confirmInteractive(
            `About to RESTORE (--clean) into database "${dbName}", overwriting its contents. ` +
              `Type "${dbName}" to confirm: `,
            dbName,
          );
          if (!ok) {
            console.error('Aborted.');
            process.exit(1);
          }
        }
        logInvocation('restore', url);

        const manifest = await readManifest(opts.input);
        if (manifest) {
          const toolMajor = await pgToolVersion('pg_restore');
          assertToolVersionCompatible(
            toolMajor,
            serverVersionMajor(manifest.pgServerVersion),
            'pg_restore',
          );
        } else {
          console.error('  note: no sidecar manifest found; skipping pre-flight version check.');
        }

        await ensureDatabase(url, {});
        await runPgRestore(url, opts.input);

        const pool = createPool(url);
        try {
          const status = await isSchemaCurrent(pool, createMigrationProvider());
          if (!status.current) {
            console.error(
              `  WARNING: schema drift after restore: ${status.reason}. Run "kici-admin db migrate".`,
            );
          }
          const keyVersion =
            manifest?.secretKeyVersion ??
            (
              await pool.query<{ max: number | null }>(
                'SELECT MAX(key_version)::int AS max FROM config_versions',
              )
            ).rows[0]?.max ??
            null;
          const warn = restoreKeyWarning({
            secretKeyVersion: keyVersion,
            keyEnvPresent: !!process.env.KICI_SECRET_KEY,
          });
          if (warn) console.error(`  ${warn}`);
        } finally {
          await pool.end().catch(() => undefined);
        }

        console.log(`db restore: restored "${dbName}" from ${opts.input}`);
        console.error(
          '\n  Next: run "kici-admin cluster reconcile-identity" to reconcile the ' +
            'cluster_id with the S3 sentinel, then restart the orchestrator.\n',
        );
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
          await recordAdminCliAccess({
            action: 'db.ensure',
            target: { type: 'database', id: name },
            outcome: 'allowed',
            meta: { result: outcome },
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
          await recordAdminCliAccess({
            action: 'db.create_role',
            target: { type: 'database', id: opts.user },
            outcome: 'allowed',
            meta: { result: outcome, createdb: !!opts.createdb },
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
        // create-readonly-user connects to the target DB itself (which owns the
        // access_log table), so record there — not the KICI_DATABASE_URL
        // fallback used by the bootstrap-DB provisioning subcommands.
        await recordAdminCliAccess(
          {
            action: 'db.create_readonly_user',
            target: { type: 'database', id: opts.user },
            outcome: 'allowed',
            meta: { result: outcome, db: dbName },
          },
          url,
        );
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
          await recordAdminCliAccess(
            {
              action: 'db.reindex',
              target: { type: 'database', id: dbName },
              outcome: 'allowed',
              meta: { reason: opts.reason },
            },
            url,
          );
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
          await recordAdminCliAccess(
            {
              action: 'db.refresh_collation_version',
              target: { type: 'database', id: dbName },
              outcome: 'allowed',
              meta: { reason: opts.reason },
            },
            url,
          );
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

/**
 * Binds the orchestrator upgrade's pre-stop capabilities to the admin API and
 * to `pg_dump`.
 *
 * Kept apart from `upgrade-safety.ts` so the decision logic there stays pure
 * and unit-testable, and apart from `versioned-upgrade.ts` so the agent upgrade
 * — which passes no hooks — carries none of this.
 *
 * Every hook runs while the service is still up. That is load-bearing for two
 * of them: the schema revert needs the newer binary's own migration provider,
 * and the drain needs a live admin API.
 */
import { readFileSync } from 'node:fs';
import { createDb, createPool } from '../../../db/client.js';
import { createDbBackup } from '../db-backup.js';
import type { AdminApiClient } from '../../api-client.js';
import { waitForQuiesce, type MigrationStatusRow } from './upgrade-safety.js';
import type { UpgradeHooks } from './versioned-upgrade.js';

/** How often the drain poller asks whether the coordinator is quiet. */
const DRAIN_POLL_INTERVAL_MS = 2_000;

/**
 * Resolve the database URL the pre-upgrade dump connects with.
 *
 * The instance's env file is the authority — the same file the service itself
 * is started from — so the dump is taken against exactly the database the
 * running orchestrator uses, not whatever the operator's shell happens to
 * export.
 */
export function readDatabaseUrlFromEnvFile(contents: string): string | null {
  for (const raw of contents.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    if (line.slice(0, eq).trim() !== 'KICI_DATABASE_URL') continue;
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    return value || null;
  }
  return null;
}

export interface BuildUpgradeHooksIo {
  readFile: (p: string) => string;
  now?: () => Date;
}

/**
 * Build the hook set for an orchestrator upgrade.
 *
 * `instanceDir` is resolved lazily, at the moment a hook runs, because the
 * upgrade resolves its target after the command is registered.
 */
export function buildUpgradeHooks(
  tryGetClient: () => AdminApiClient | null,
  io?: BuildUpgradeHooksIo,
): UpgradeHooks {
  const readFile = io?.readFile ?? ((p: string) => readFileSync(p, 'utf8'));

  /**
   * The admin API, or a descriptive throw when no credentials are configured.
   *
   * Throwing rather than exiting is the whole point: each caller already
   * degrades — the schema guard reads "could not be reached" and the drain
   * warns and continues — and `getClient` would have exited the process
   * instead, taking a working upgrade down with it.
   */
  const requireClient = (action: string): AdminApiClient => {
    const client = tryGetClient();
    if (!client) {
      throw new Error(
        `${action} needs the admin API, but no admin token is configured ` +
          `(pass --token, or set KICI_ADMIN_TOKEN).`,
      );
    }
    return client;
  };

  return {
    // async, so a missing token rejects rather than throwing synchronously —
    // every caller awaits, and a rejection is the contract they handle.
    migrationStatus: async () =>
      requireClient('reading the migration ledger').get<{
        migrations: MigrationStatusRow[];
      }>('/api/v1/admin/db/migrate/status'),

    drain: async (timeoutSeconds: number) => {
      const client = requireClient('draining the coordinator');
      await client.drain('drain');
      return waitForQuiesce(() => client.drainStatus(), {
        timeoutMs: timeoutSeconds * 1000,
        intervalMs: DRAIN_POLL_INTERVAL_MS,
      });
    },

    migrateDown: async (head: string) => {
      await requireClient('reverting the schema').post('/api/v1/admin/db/migrate/to', {
        name: head,
      });
    },

    backup: async ({ outputPath, envFilePath }) => {
      const databaseUrl = resolveDatabaseUrl(envFilePath, readFile);
      const pool = createPool(databaseUrl);
      const db = createDb(pool);
      try {
        const res = await createDbBackup({
          databaseUrl,
          outputPath,
          db,
          pool,
          now: (io?.now ?? (() => new Date()))(),
        });
        return { outputPath: res.outputPath, byteSize: res.byteSize };
      } finally {
        await db.destroy();
      }
    },
  };
}

/**
 * Read `KICI_DATABASE_URL` from the instance env file, falling back to the
 * process environment.
 *
 * Throws rather than returning null: an upgrade that cannot find the database
 * must refuse loudly, since a silent skip is exactly the failure this hook
 * exists to prevent.
 */
export function resolveDatabaseUrl(envFilePath: string, readFile: (p: string) => string): string {
  let fromFile: string | null = null;
  try {
    fromFile = readDatabaseUrlFromEnvFile(readFile(envFilePath));
  } catch {
    // The env file may legitimately not be where the dump directory implies.
    fromFile = null;
  }
  const url = fromFile ?? process.env.KICI_DATABASE_URL ?? null;
  if (!url) {
    throw new Error(
      `KICI_DATABASE_URL could not be resolved (looked in ${envFilePath} and the environment).`,
    );
  }
  return url;
}

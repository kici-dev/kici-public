/**
 * Binds the orchestrator upgrade's pre-stop hooks to the admin API and
 * `pg_dump`. Kept apart from `upgrade-safety.ts` (pure decision logic) and
 * `versioned-upgrade.ts` (the agent upgrade passes no hooks).
 *
 * Every hook runs while the service is up: the schema revert needs the newer
 * binary's migration provider, and the drain needs a live admin API.
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
 * The pre-upgrade dump's database URL. The service's own env file is the
 * authority, so the dump hits the database the orchestrator uses, not
 * whatever the operator's shell exports.
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
 * `instanceDir` resolves lazily, when a hook runs: the upgrade resolves its
 * target after the command is registered.
 */
export function buildUpgradeHooks(
  tryGetClient: () => AdminApiClient | null,
  io?: BuildUpgradeHooksIo,
): UpgradeHooks {
  const readFile = io?.readFile ?? ((p: string) => readFileSync(p, 'utf8'));

  /**
   * Throws, not exits, without credentials: each caller degrades (the schema
   * guard reads "could not be reached", the drain warns and continues), while
   * `getClient` would exit and take a working upgrade down.
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
    // async: a missing token rejects, the contract every awaiting caller handles.
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
 * From the env file, else the process environment. Throws rather than
 * returning null: a silent skip is the failure this hook exists to prevent.
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

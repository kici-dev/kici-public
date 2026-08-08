/**
 * Helpers for `kici-admin db backup` / `db restore`. Kept out of db.ts so the
 * command actions stay thin and the pg_dump/pg_restore + manifest logic is
 * unit-testable without Commander or a real Postgres. Every external effect
 * (process exec, filesystem) is an injectable seam so tests never spawn a
 * binary or touch disk.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import os from 'node:os';
import { readFile as fsReadFile, writeFile as fsWriteFile } from 'node:fs/promises';
import type { Kysely } from 'kysely';
import type { Database, NewBackupRun } from '../../db/types.js';

const execFileAsync = promisify(execFile);

export type RunFn = (
  bin: string,
  args: string[],
  opts?: { env?: NodeJS.ProcessEnv },
) => Promise<{ stdout: string; stderr: string }>;

const defaultRun: RunFn = async (bin, args, opts) => {
  const { stdout, stderr } = await execFileAsync(bin, args, {
    env: opts?.env ?? process.env,
    maxBuffer: 64 * 1024 * 1024,
  });
  return { stdout: stdout.toString(), stderr: stderr.toString() };
};

export type FsLike = {
  writeFile: (path: string, data: string) => Promise<void>;
  readFile: (path: string) => Promise<string>;
};

const defaultFs: FsLike = {
  writeFile: (p, data) => fsWriteFile(p, data, 'utf-8'),
  readFile: (p) => fsReadFile(p, 'utf-8'),
};

export interface BackupManifest {
  createdAt: string;
  byteSize: number;
  secretKeyVersion: number | null;
  pgServerVersion: string;
  migrationsHash: string;
  clusterId: string | null;
  hostname: string;
}

export function manifestPath(dumpPath: string): string {
  return `${dumpPath}.manifest.json`;
}

export function defaultDumpPath(now: Date): string {
  const ts = now.toISOString().replace(/[:.]/g, '-');
  return `./kici-orchestrator-backup-${ts}.dump`;
}

export function parsePgToolMajor(versionOutput: string): number {
  const m = versionOutput.match(/\)\s+(\d+)/);
  if (!m) throw new Error(`Could not parse Postgres tool version from: ${versionOutput.trim()}`);
  return parseInt(m[1], 10);
}

export function serverVersionMajor(numStr: string): number {
  return Math.floor(parseInt(numStr, 10) / 10000);
}

export function assertToolVersionCompatible(
  toolMajor: number,
  serverMajor: number,
  tool: 'pg_dump' | 'pg_restore',
): void {
  if (toolMajor < serverMajor) {
    throw new Error(
      `${tool} ${toolMajor} is older than the server (major ${serverMajor}). ` +
        `Install a postgresql-client whose major is >= ${serverMajor} and retry.`,
    );
  }
}

export async function pgToolVersion(
  bin: 'pg_dump' | 'pg_restore',
  run: RunFn = defaultRun,
): Promise<number> {
  try {
    const { stdout } = await run(bin, ['--version']);
    return parsePgToolMajor(stdout);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(
        `${bin} not found on PATH. Install the postgresql-client package ` +
          `(matching your server major) and retry.`,
      );
    }
    throw err;
  }
}

export async function writeManifest(
  dumpPath: string,
  m: BackupManifest,
  fs: FsLike = defaultFs,
): Promise<void> {
  await fs.writeFile(manifestPath(dumpPath), JSON.stringify(m, null, 2) + '\n');
}

export async function readManifest(
  dumpPath: string,
  fs: FsLike = defaultFs,
): Promise<BackupManifest | null> {
  try {
    return JSON.parse(await fs.readFile(manifestPath(dumpPath))) as BackupManifest;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

export async function readServerAndKeyMeta(pool: import('pg').Pool): Promise<{
  serverVersionNum: string;
  secretKeyVersion: number | null;
  clusterId: string | null;
}> {
  const ver = await pool.query<{ server_version_num: string }>('SHOW server_version_num');
  const key = await pool.query<{ max: number | null }>(
    'SELECT MAX(key_version)::int AS max FROM config_versions',
  );
  const cluster = await pool.query<{ value: string }>(
    "SELECT value FROM cluster_meta WHERE key = 'cluster_id' LIMIT 1",
  );
  return {
    serverVersionNum: ver.rows[0].server_version_num,
    secretKeyVersion: key.rows[0]?.max ?? null,
    clusterId: cluster.rows[0]?.value ?? null,
  };
}

/**
 * Translate a libpq connection URL into a PG* environment overlay. The
 * connection URL (which embeds the DB password) MUST NOT be passed as a
 * pg_dump/pg_restore argv element: `/proc/<pid>/cmdline` is world-readable, so
 * a URL-in-argv leaks the DB password to every local user for the tool's
 * lifetime. libpq reads PGHOST/PGPORT/PGUSER/PGPASSWORD/PGDATABASE/PGSSLMODE
 * from the environment (`/proc/<pid>/environ`, owner-only 0400) instead — the
 * same credential-off-the-command-line discipline used elsewhere in the repo.
 * Only the components that are actually present are set, so socket / trust
 * connections (no password, no port) are left untouched.
 */
export function pgEnvFromUrl(url: string): NodeJS.ProcessEnv {
  const parsed = new URL(url);
  const env: NodeJS.ProcessEnv = {};
  if (parsed.hostname) env.PGHOST = decodeURIComponent(parsed.hostname);
  if (parsed.port) env.PGPORT = parsed.port;
  if (parsed.username) env.PGUSER = decodeURIComponent(parsed.username);
  if (parsed.password) env.PGPASSWORD = decodeURIComponent(parsed.password);
  const dbName = parsed.pathname.replace(/^\//, '');
  if (dbName) env.PGDATABASE = dbName;
  const sslmode = parsed.searchParams.get('sslmode');
  if (sslmode) env.PGSSLMODE = sslmode;
  return env;
}

export async function runPgDump(
  url: string,
  outputPath: string,
  run: RunFn = defaultRun,
): Promise<void> {
  await run('pg_dump', ['-Fc', '--file', outputPath], {
    env: { ...process.env, ...pgEnvFromUrl(url) },
  });
}

export async function runPgRestore(
  url: string,
  inputPath: string,
  run: RunFn = defaultRun,
): Promise<void> {
  const env = pgEnvFromUrl(url);
  // pg_restore needs an explicit --dbname to enter "connect + restore into DB"
  // mode; without it (unlike pg_dump) it does NOT fall back to PGDATABASE and
  // instead demands -f to emit SQL to a file. The DB name is not a secret, so
  // it is safe in argv; the connection credentials still ride in PG* env.
  const dbName = env.PGDATABASE ?? new URL(url).pathname.replace(/^\//, '');
  await run('pg_restore', ['--clean', '--if-exists', '--no-owner', '--dbname', dbName, inputPath], {
    env: { ...process.env, ...env },
  });
}

export async function recordBackupRun(db: Kysely<Database>, row: NewBackupRun): Promise<void> {
  await db.insertInto('backup_runs').values(row).execute();
}

export function buildBackupManifest(input: {
  now: Date;
  byteSize: number;
  serverVersionNum: string;
  secretKeyVersion: number | null;
  clusterId: string | null;
  migrationsHash: string;
  hostname: string;
}): BackupManifest {
  return {
    createdAt: input.now.toISOString(),
    byteSize: input.byteSize,
    secretKeyVersion: input.secretKeyVersion,
    pgServerVersion: input.serverVersionNum,
    migrationsHash: input.migrationsHash,
    clusterId: input.clusterId,
    hostname: input.hostname,
  };
}

/**
 * Message to print after a restore about the secret-key requirement. Returns
 * null when the dump carried no encrypted secrets (nothing to warn about),
 * a loud warning when secrets exist but no `KICI_SECRET_KEY` is set on the box,
 * or an informational reminder when a key IS set (it must be the matching one).
 */
export function restoreKeyWarning(input: {
  secretKeyVersion: number | null;
  keyEnvPresent: boolean;
}): string | null {
  if (input.secretKeyVersion == null) return null;
  if (!input.keyEnvPresent) {
    return (
      `KICI_SECRET_KEY is not set, but this dump contains encrypted secrets ` +
      `(key generation ${input.secretKeyVersion}). Secrets will NOT decrypt until you ` +
      `set the matching KICI_SECRET_KEY on this box.`
    );
  }
  return (
    `This dump's secrets are under key generation ${input.secretKeyVersion}. ` +
    `Ensure the KICI_SECRET_KEY set here is the one that encrypted them, or secrets will not decrypt.`
  );
}

export { os };

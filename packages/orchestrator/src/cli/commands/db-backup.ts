/**
 * Helpers for `kici-admin db backup` / `db restore`, outside db.ts so they test
 * without Commander or a real Postgres. Process exec and filesystem access are
 * injectable, so tests never spawn a binary or touch disk.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import os from 'node:os';
import {
  readFile as fsReadFile,
  readdir as fsReaddir,
  stat,
  unlink as fsUnlink,
  writeFile as fsWriteFile,
} from 'node:fs/promises';
import path from 'node:path';
import type { Kysely } from 'kysely';
import { computeMigrationsHash } from '@kici-dev/shared';
import { createMigrationProvider } from '../../db/migration-provider.js';
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

export interface CreateDbBackupOptions {
  /** libpq connection URL. */
  databaseUrl: string;
  outputPath: string;
  /** Inserts the `backup_runs` row. */
  db: Kysely<Database>;
  /** Reads the server version, key generation, and cluster id. */
  pool: import('pg').Pool;
  now: Date;
}

export interface CreateDbBackupResult {
  outputPath: string;
  byteSize: number;
  manifest: BackupManifest;
}

export function manifestPath(dumpPath: string): string {
  return `${dumpPath}.manifest.json`;
}

/** `kici-orchestrator-backup-<timestamp>.dump` — no directory component. */
export function dumpFileName(now: Date): string {
  const ts = now.toISOString().replace(/[:.]/g, '-');
  return `kici-orchestrator-backup-${ts}.dump`;
}

export function defaultDumpPath(now: Date): string {
  return `./${dumpFileName(now)}`;
}

/** Timestamped dump path inside a retention directory. */
export function dumpPathIn(dir: string, now: Date): string {
  return path.join(dir, dumpFileName(now));
}

export interface PruneIo {
  readdir: (dir: string) => Promise<string[]>;
  mtimeMs: (p: string) => Promise<number>;
  unlink: (p: string) => Promise<void>;
}

const defaultPruneIo: PruneIo = {
  readdir: (dir) => fsReaddir(dir),
  mtimeMs: async (p) => (await stat(p)).mtimeMs,
  unlink: (p) => fsUnlink(p),
};

/**
 * Keep the newest {@link keep} `.dump` files in {@link dir}, deleting the rest
 * with their `.manifest.json` sidecars; newest by mtime, tiebroken by the
 * chronologically sorting filename. Returns every path removed. A `keep` of 0
 * or less disables pruning, so a misconfigured value never empties the directory.
 */
export async function pruneBackupDir(
  dir: string,
  keep: number,
  io: PruneIo = defaultPruneIo,
): Promise<string[]> {
  if (keep <= 0) return [];
  const names = (await io.readdir(dir)).filter((n) => n.endsWith('.dump'));
  const stamped: Array<{ name: string; mtimeMs: number }> = [];
  for (const name of names) {
    stamped.push({ name, mtimeMs: await io.mtimeMs(path.join(dir, name)) });
  }
  stamped.sort((a, b) => b.mtimeMs - a.mtimeMs || b.name.localeCompare(a.name));

  const removed: string[] = [];
  for (const { name } of stamped.slice(keep)) {
    const dumpPath = path.join(dir, name);
    await io.unlink(dumpPath);
    removed.push(dumpPath);
    try {
      await io.unlink(manifestPath(dumpPath));
      removed.push(manifestPath(dumpPath));
    } catch {
      // No sidecar (older dump, or a partly cleaned directory): the dump is gone, which suffices.
    }
  }
  return removed;
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
 * A libpq URL as a PG* environment overlay. The URL embeds the password and
 * MUST NOT go into pg_dump/pg_restore argv: `/proc/<pid>/cmdline` is
 * world-readable, while `/proc/<pid>/environ` is owner-only 0400. Only the
 * components present are set, so socket / trust connections stay untouched.
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
  // Unlike pg_dump, pg_restore does NOT fall back to PGDATABASE: without
  // --dbname it demands -f and emits SQL. The DB name is no secret, so argv is
  // safe; credentials still ride in PG* env.
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
 * Check the `pg_dump` version, dump, write the sidecar manifest, and record the
 * `backup_runs` row. Prints nothing and never exits: failures throw, so
 * `kici-admin db backup` and the pre-upgrade hook share it.
 */
export async function createDbBackup(opts: CreateDbBackupOptions): Promise<CreateDbBackupResult> {
  const { databaseUrl, outputPath, db, pool, now } = opts;

  const meta = await readServerAndKeyMeta(pool);
  const toolMajor = await pgToolVersion('pg_dump');
  assertToolVersionCompatible(toolMajor, serverVersionMajor(meta.serverVersionNum), 'pg_dump');

  await runPgDump(databaseUrl, outputPath);
  const byteSize = (await stat(outputPath)).size;
  const migrationsHash = await computeMigrationsHash(createMigrationProvider());
  const hostname = os.hostname();

  const manifest = buildBackupManifest({
    now,
    byteSize,
    serverVersionNum: meta.serverVersionNum,
    secretKeyVersion: meta.secretKeyVersion,
    clusterId: meta.clusterId,
    migrationsHash,
    hostname,
  });
  await writeManifest(outputPath, manifest);
  await recordBackupRun(db, {
    dump_path: outputPath,
    byte_size: String(byteSize),
    secret_key_version: meta.secretKeyVersion,
    pg_server_version: meta.serverVersionNum,
    migrations_hash: migrationsHash,
    hostname,
  });

  return { outputPath, byteSize, manifest };
}

/**
 * The post-restore secret-key note: null when the dump has no encrypted
 * secrets, a warning when no `KICI_SECRET_KEY` is set, else a reminder that the
 * set key must be the matching one.
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

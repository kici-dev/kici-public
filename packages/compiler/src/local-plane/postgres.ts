import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { $ } from 'zx';
import { toErrorMessage } from '@kici-dev/core';
import { planePaths, planePorts } from './paths.js';
import { rotatePlaneLogIfOversized } from './plane-log.js';

/** Podman fallback image. The container-pin tooling rewrites this pin in place. */
export const PLANE_PG_IMAGE = 'docker.io/library/postgres:18.6-alpine';

export const PLANE_PG_CONTAINER = 'kici-local-postgres';

export type PlanePgHandle = {
  url: string;
  kind: 'embedded' | 'podman';
  stop(): Promise<void>;
};

async function defaultReadyPoller(_port: number): Promise<boolean> {
  // Probed inside the container, so the host needs no `pg_isready`.
  for (let i = 0; i < 60; i++) {
    try {
      await $`podman exec ${PLANE_PG_CONTAINER} pg_isready -U kici`.quiet();
      return true;
    } catch {
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  return false;
}

/**
 * Resolves the `pg_ctl` bundled with embedded-postgres, mirroring its
 * platform → binary-package mapping. The binary package resolves through
 * embedded-postgres's module context: pnpm isolates it as a transitive
 * dependency, so it is not resolvable from here.
 */
function resolvePgCtl(): string {
  const platform = os.platform();
  const arch = os.arch();
  const packages: Record<string, string> = {
    'darwin:arm64': '@embedded-postgres/darwin-arm64',
    'darwin:x64': '@embedded-postgres/darwin-x64',
    'linux:arm64': '@embedded-postgres/linux-arm64',
    'linux:arm': '@embedded-postgres/linux-arm',
    'linux:ia32': '@embedded-postgres/linux-ia32',
    'linux:ppc64': '@embedded-postgres/linux-ppc64',
    'linux:x64': '@embedded-postgres/linux-x64',
    'win32:x64': '@embedded-postgres/windows-x64',
  };
  const pkg = packages[`${platform}:${arch}`];
  if (!pkg) throw new Error(`unsupported platform for embedded Postgres: ${platform}/${arch}`);
  const require = createRequire(import.meta.url);
  const epRequire = createRequire(require.resolve('embedded-postgres'));
  // The package exposes only dist/index.js; pg_ctl is at ../native/bin from it.
  const entry = epRequire.resolve(pkg);
  const binName = platform === 'win32' ? 'pg_ctl.exe' : 'pg_ctl';
  return path.resolve(path.dirname(entry), '..', 'native', 'bin', binName);
}

function appendPgLog(line: string): void {
  fs.appendFileSync(planePaths().pgLogFile, line.endsWith('\n') ? line : `${line}\n`);
}

/** PostgreSQL `duplicate_database`: the bootstrap already created `kici_local`. */
export function isDuplicateDatabaseError(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: unknown }).code === '42P04';
}

/**
 * Initialises the cluster and the `kici_local` database once, with a
 * short-lived in-process server; the persistent postmaster is daemonized
 * separately so it outlives this CLI.
 *
 * The stamp, written only after the database exists, marks the bootstrap done.
 * `PG_VERSION` without a stamp is a bootstrap that stopped between `initdb` and
 * `CREATE DATABASE`: the next start skips `initdb` and finishes the rest. Server
 * output goes to the plane's Postgres log, never the terminal.
 */
async function ensureEmbeddedCluster(port: number): Promise<void> {
  const { root, pgData, pgLogFile, pgBootstrapStamp } = planePaths();
  if (fs.existsSync(pgBootstrapStamp)) return;
  fs.mkdirSync(root, { recursive: true });
  // Imported lazily: embedded-postgres installs a process-wide SIGINT/SIGTERM
  // handler that exits at once. The commands barrel loads this module, and that
  // handler would end `kici run remote` before its Ctrl-C cancel reaches the
  // orchestrator.
  const { default: EmbeddedPostgres } = await import('embedded-postgres');
  const pg = new EmbeddedPostgres({
    databaseDir: pgData,
    port,
    user: 'kici',
    password: 'kici',
    persistent: true,
    onLog: (message) => appendPgLog(message),
    onError: (err) => appendPgLog(`[ERROR] ${toErrorMessage(err)}`),
  });
  // Set once the in-process server is up, so a failure after that point stops
  // it: a server left running would hold the plane port the fallback needs.
  let started = false;
  try {
    if (!fs.existsSync(path.join(pgData, 'PG_VERSION'))) await pg.initialise();
    await pg.start();
    started = true;
    try {
      await pg.createDatabase('kici_local');
    } catch (err) {
      if (!isDuplicateDatabaseError(err)) throw err;
    }
    started = false;
    await pg.stop();
  } catch (err) {
    if (started) await pg.stop().catch(() => {});
    throw new Error(
      `embedded PostgreSQL bootstrap failed: ${toErrorMessage(err)}. Server log: ${pgLogFile}`,
      { cause: err },
    );
  }
  fs.writeFileSync(pgBootstrapStamp, `${new Date().toISOString()}\n`);
}

/**
 * Whether this plane's embedded postmaster already serves `port`. `pg_ctl
 * start` fails against a running cluster, so a boot that reclaims the plane
 * port but leaves PostgreSQL up (reclaiming another plane's orchestrator
 * signals only the port holder) would otherwise fall through to Podman and fail.
 *
 * The port comes from `postmaster.pid` line 4, so a postmaster on another port
 * is never mistaken for one this plane can reuse.
 */
export async function embeddedClusterIsServing(port: number): Promise<boolean> {
  const { pgData } = planePaths();
  const pidFile = path.join(pgData, 'postmaster.pid');
  let runningPort: number;
  try {
    runningPort = Number(fs.readFileSync(pidFile, 'utf-8').split('\n')[3]);
  } catch {
    return false; // No pid file — nothing is running from this data dir.
  }
  if (runningPort !== port) return false;
  try {
    // Exit 0: running. 3 (stopped) and 4 (unusable data dir) both mean "start it".
    await $`${resolvePgCtl()} -D ${pgData} status`.quiet();
    return true;
  } catch {
    return false;
  }
}

/**
 * Starts a detached postmaster via `pg_ctl` so it survives this CLI: the
 * in-process server dies with embedded-postgres's exit hook. Always starts one;
 * the caller checks whether a cluster already serves.
 */
async function defaultEmbeddedDaemon(port: number): Promise<void> {
  const { pgData, pgLogFile } = planePaths();
  const pgCtl = resolvePgCtl();
  await $`${pgCtl} -D ${pgData} -o ${`-p ${port}`} -l ${pgLogFile} -w start`.quiet();
}

/** Handle-independent: reads the data dir. */
async function stopEmbeddedDaemon(): Promise<void> {
  const { pgData } = planePaths();
  if (!fs.existsSync(path.join(pgData, 'postmaster.pid'))) return;
  const pgCtl = resolvePgCtl();
  await $`${pgCtl} -D ${pgData} stop -m fast`.quiet().catch(() => {});
}

/** Handle-independent, so `kici local down` can stop what `up` started. */
export async function stopPlanePostgres(kind: 'embedded' | 'podman'): Promise<void> {
  if (kind === 'podman') {
    await $`podman rm -f ${PLANE_PG_CONTAINER}`.quiet().catch(() => {});
  } else {
    await stopEmbeddedDaemon();
  }
}

/**
 * Prefers the zero-dependency `embedded-postgres` binary, daemonized via pg_ctl
 * so it stays warm. Falls back to a podman container when the embedded path
 * fails, or when `forcePodman` / `KICI_LOCAL_PG_MODE=podman` forces it.
 */
export async function startPlanePostgres(
  opts: {
    forcePodman?: boolean;
    readyPoller?: (port: number) => Promise<boolean>;
    embeddedDaemon?: (port: number) => Promise<void>;
  } = {},
): Promise<PlanePgHandle> {
  const readyPoller = opts.readyPoller ?? defaultReadyPoller;
  const embeddedDaemon = opts.embeddedDaemon ?? defaultEmbeddedDaemon;
  const { postgres: port } = planePorts();
  const url = `postgres://kici:kici@127.0.0.1:${port}/kici_local`;
  const forcePodman = opts.forcePodman || process.env.KICI_LOCAL_PG_MODE === 'podman';

  let embeddedError: unknown;
  if (!forcePodman) {
    try {
      // Reuse a cluster already serving the port, before any bootstrap: the
      // bootstrap server and `pg_ctl start` both fail against it, and its
      // postmaster holds the log fd, so rotating the file would send every later
      // line to the rotated copy.
      if (!(await embeddedClusterIsServing(port))) {
        await ensureEmbeddedCluster(port);
        rotatePlaneLogIfOversized(planePaths().pgLogFile);
        await embeddedDaemon(port);
      }
      return { url, kind: 'embedded', stop: () => stopEmbeddedDaemon() };
    } catch (err) {
      // Kept for the error raised if podman fails too.
      embeddedError = err;
    }
  }

  const child = spawn(
    'podman',
    [
      'run',
      '-d',
      '--replace',
      '--name',
      PLANE_PG_CONTAINER,
      '-p',
      `127.0.0.1:${port}:5432`,
      '-e',
      'POSTGRES_USER=kici',
      '-e',
      'POSTGRES_PASSWORD=kici',
      '-e',
      'POSTGRES_DB=kici_local',
      PLANE_PG_IMAGE,
    ],
    { stdio: 'ignore', detached: true },
  );
  child.unref();
  if (!(await readyPoller(port))) {
    const embedded =
      embeddedError === undefined ? '' : `embedded: ${toErrorMessage(embeddedError)}; `;
    throw new Error(`local Postgres did not start: ${embedded}podman: did not become ready`);
  }
  return {
    url,
    kind: 'podman',
    stop: async () => {
      await $`podman rm -f ${PLANE_PG_CONTAINER}`.quiet().catch(() => {});
    },
  };
}

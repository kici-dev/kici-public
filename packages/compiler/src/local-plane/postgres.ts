import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import EmbeddedPostgres from 'embedded-postgres';
import { $ } from 'zx';
import { planePaths, planePorts } from './paths.js';

/**
 * Podman fallback Postgres image for the local dev plane. Pinned via
 * `TS_CONST_PINS` in hack/containers-lock.ts (identity
 * docker.io/library/postgres+alpine), so a lock bump rewrites it in place.
 */
export const PLANE_PG_IMAGE = 'docker.io/library/postgres:18.4-alpine';

/** Name of the fallback podman Postgres container. */
export const PLANE_PG_CONTAINER = 'kici-local-postgres';

export type PlanePgHandle = {
  url: string;
  kind: 'embedded' | 'podman';
  stop(): Promise<void>;
};

let readyPoller = defaultReadyPoller;

/** Test seam: override the podman readiness poller. */
export function __setReadyPollerForTest(fn: typeof readyPoller): void {
  readyPoller = fn;
}

let embeddedDaemon = defaultEmbeddedDaemon;

/** Test seam: override the embedded postmaster daemonizer. */
export function __setEmbeddedDaemonForTest(fn: typeof embeddedDaemon): void {
  embeddedDaemon = fn;
}

async function defaultReadyPoller(_port: number): Promise<boolean> {
  // Probe readiness from inside the container so the host does not need a
  // PostgreSQL client (`pg_isready`) installed.
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

/** Whether a podman binary is available on PATH. */
export async function isPodmanAvailable(): Promise<boolean> {
  try {
    await $`podman --version`.quiet();
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolve the platform-specific `pg_ctl` binary bundled with embedded-postgres.
 * Mirrors the package's own platform → binary-package mapping, resolving the
 * binary package through embedded-postgres's module context (pnpm isolates it
 * as a transitive dependency, so it is not directly resolvable here) and
 * computing the `native/bin/pg_ctl` path from the resolved package directory.
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
  // The binary package exposes only its entry (dist/index.js); pg_ctl lives at
  // ../native/bin/pg_ctl relative to it (matching the package's own resolution).
  const entry = epRequire.resolve(pkg);
  const binName = platform === 'win32' ? 'pg_ctl.exe' : 'pg_ctl';
  return path.resolve(path.dirname(entry), '..', 'native', 'bin', binName);
}

/**
 * Initialise the embedded Postgres cluster + the `kici_local` database once. A
 * short-lived in-process server is used only for the one-time bootstrap; the
 * persistent postmaster is started separately (daemonized) so it outlives this
 * CLI invocation.
 */
async function ensureEmbeddedCluster(port: number): Promise<void> {
  const { pgData } = planePaths();
  if (fs.existsSync(path.join(pgData, 'PG_VERSION'))) return;
  const pg = new EmbeddedPostgres({
    databaseDir: pgData,
    port,
    user: 'kici',
    password: 'kici',
    persistent: true,
  });
  await pg.initialise();
  await pg.start();
  await pg.createDatabase('kici_local').catch(() => {});
  await pg.stop();
}

/**
 * Start a detached embedded postmaster via `pg_ctl` so it survives the exit of
 * this CLI process (embedded-postgres's in-process server is killed by its own
 * exit hook, so it cannot back a warm plane).
 */
async function defaultEmbeddedDaemon(port: number): Promise<void> {
  const { pgData, logFile } = planePaths();
  const pgCtl = resolvePgCtl();
  await $`${pgCtl} -D ${pgData} -o ${`-p ${port}`} -l ${`${logFile}.pg`} -w start`.quiet();
}

/** Stop the detached embedded postmaster (handle-independent, reads the data dir). */
async function stopEmbeddedDaemon(): Promise<void> {
  const { pgData } = planePaths();
  if (!fs.existsSync(path.join(pgData, 'postmaster.pid'))) return;
  const pgCtl = resolvePgCtl();
  await $`${pgCtl} -D ${pgData} stop -m fast`.quiet().catch(() => {});
}

/**
 * Stop the plane's Postgres by backend kind. Handle-independent so a separate
 * CLI invocation (`kici local down`) can tear down what `up` started.
 */
export async function stopPlanePostgres(kind: 'embedded' | 'podman'): Promise<void> {
  if (kind === 'podman') {
    await $`podman rm -f ${PLANE_PG_CONTAINER}`.quiet().catch(() => {});
  } else {
    await stopEmbeddedDaemon();
  }
}

/**
 * Provision the local dev plane's Postgres. Prefers the zero-dependency
 * `embedded-postgres` binary (daemonized via pg_ctl so it stays warm); falls
 * back to a podman Postgres container when the embedded binary is unavailable
 * (or when forced via `forcePodman` / `KICI_LOCAL_PG_MODE=podman`).
 */
export async function startPlanePostgres(
  opts: { forcePodman?: boolean } = {},
): Promise<PlanePgHandle> {
  const { postgres: port } = planePorts();
  const url = `postgres://kici:kici@127.0.0.1:${port}/kici_local`;
  const forcePodman = opts.forcePodman || process.env.KICI_LOCAL_PG_MODE === 'podman';

  if (!forcePodman) {
    try {
      await ensureEmbeddedCluster(port);
      await embeddedDaemon(port);
      return { url, kind: 'embedded', stop: () => stopEmbeddedDaemon() };
    } catch {
      // Native binary unavailable on this platform — fall through to podman.
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
    throw new Error('local Postgres (podman) did not become ready');
  }
  return {
    url,
    kind: 'podman',
    stop: async () => {
      await $`podman rm -f ${PLANE_PG_CONTAINER}`.quiet().catch(() => {});
    },
  };
}

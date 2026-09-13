/**
 * Shared vitest `globalSetup` that gives the real-Postgres suites a database.
 *
 * The orchestrator and Platform suites that exercise real SQL — per-migration
 * schema tests, repositories, stores, and everything downstream of them — read
 * the admin connection string from `KICI_TEST_ADMIN_DATABASE_URL` at module
 * scope and skip when it is absent. This setup starts a throwaway PostgreSQL
 * container and sets that variable before the test workers fork, so those
 * suites execute in an ordinary `pnpm test` instead of reporting skipped-green.
 *
 * It is selection-aware: the container starts only when the run's selected
 * specs actually include a gated module, so `vitest run src/routes` costs
 * nothing. Both packages reference this file by relative path from their own
 * vitest config; they never import each other's code.
 */
import { readFileSync } from 'node:fs';
import { $ } from 'zx';
import type { TestProject } from 'vitest/node';
import {
  DB_GATE_ENV,
  DB_SKIP_ENV,
  DB_TEST_PG_IMAGE,
  resolveContainerRuntime,
  selectStaleDbTestContainers,
  selectedDbGatedFiles,
  type ContainerRuntime,
} from './db-test-postgres-support.ts';

/**
 * Prefix every throwaway container shares, so a leaked one is identifiable by
 * name. `--rm` plus the returned teardown removes the container on any ordinary
 * exit (including a SIGINT vitest handles); a hard kill of the runner leaves it
 * running, and `podman/docker rm -f kici-db-test-pg-*` clears it by hand.
 */
const CONTAINER_PREFIX = 'kici-db-test-pg';

const POSTGRES_USER = 'testuser';
const POSTGRES_PASSWORD = 'testpw';
const POSTGRES_DB = 'postgres';

/** Readiness poll budget: 120 attempts at 500ms is a minute of cold start. */
const READY_ATTEMPTS = 120;
const READY_INTERVAL_MS = 500;

/**
 * Reap leaked containers older than this. Matches the 6h age gate every
 * kici-leak-sweep pass uses; a live test's container is seconds to minutes old,
 * never hours, so the gate cannot reach one.
 */
const STALE_CONTAINER_MAX_AGE_MS = 6 * 60 * 60 * 1000;

const shell = $({ nothrow: true, stdio: ['ignore', 'pipe', 'pipe'] });

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Vitest exposes the CLI's positional filters as an undocumented
 * `filenamePattern` field. Calling `getRelevantTestSpecifications()` with no
 * argument ignores the filter and returns every spec in the project, which
 * would spin a container for `vitest run src/routes`; `config.filters` is
 * always undefined. A unit test guards that this field still exists, so a
 * vitest upgrade that moves it fails loudly instead of silently returning the
 * gated suites to skipped-green.
 */
function cliFilters(project: TestProject): string[] {
  return (project.vitest as unknown as { filenamePattern?: string[] }).filenamePattern ?? [];
}

/** Resolve the host port the container's 5432 was published on. */
async function publishedPort(runtime: ContainerRuntime, name: string): Promise<string> {
  const out = await shell`${runtime} port ${name} 5432`;
  if (out.exitCode !== 0) {
    throw new Error(`${runtime} port ${name} 5432 failed: ${out.stderr.trim()}`);
  }
  // `0.0.0.0:49153` (podman may also print an IPv6 line) — take the last colon field.
  const first = out.stdout.trim().split('\n')[0] ?? '';
  const port = first.trim().split(':').pop();
  if (!port || !/^\d+$/.test(port)) {
    throw new Error(`could not parse a published port from ${runtime} port output: "${first}"`);
  }
  return port;
}

/**
 * Poll `pg_isready` from INSIDE the container, so the host needs no psql
 * client and the probe follows the same network path the server listens on.
 *
 * `-h 127.0.0.1` forces the probe over TCP rather than the default unix
 * socket. The entrypoint runs its bootstrap steps against a socket-only
 * server started with `listen_addresses=''`, so a socket probe can report
 * "accepting connections" while the port the suites dial is still closed.
 */
async function waitForReady(runtime: ContainerRuntime, name: string): Promise<void> {
  for (let attempt = 0; attempt < READY_ATTEMPTS; attempt++) {
    const out = await shell`${runtime} exec ${name} pg_isready -h 127.0.0.1 -U ${POSTGRES_USER}`;
    if (out.exitCode === 0) return;
    await sleep(READY_INTERVAL_MS);
  }
  throw new Error(
    `Postgres in ${name} never became ready after ` +
      `${(READY_ATTEMPTS * READY_INTERVAL_MS) / 1000}s (image ${DB_TEST_PG_IMAGE}).`,
  );
}

export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  const noop = async (): Promise<void> => {};

  if (process.env[DB_SKIP_ENV] === '1') return noop;
  // An operator-supplied server wins: this is the documented long-lived-server
  // debugging workflow, and we must not shadow it with a throwaway container.
  if (process.env[DB_GATE_ENV]) return noop;

  const specs = await project.vitest.getRelevantTestSpecifications(cliFilters(project));
  const gated = selectedDbGatedFiles(
    specs.map((spec) => spec.moduleId),
    (p) => readFileSync(p, 'utf-8'),
  );
  if (gated.length === 0) return noop;

  const runtime = resolveContainerRuntime();

  // A hard-killed vitest runner skips the teardown below, so `--rm` never fires
  // and the container is left running — the leak the CONTAINER_PREFIX comment
  // predicts. Reap old strays here, where the runtime is already resolved.
  // Purely best-effort: hygiene must never fail a test run, so every call goes
  // through the module's nothrow `shell` and a failure is simply ignored.
  const listed =
    await shell`${runtime} ps --filter ${`name=${CONTAINER_PREFIX}`} --format {{.Names}}`;
  if (listed.exitCode === 0) {
    const stale = selectStaleDbTestContainers(
      listed.stdout.split('\n').filter((line) => line.trim() !== ''),
      Date.now(),
      STALE_CONTAINER_MAX_AGE_MS,
    );
    for (const container of stale) {
      await shell`${runtime} rm -f ${container}`;
    }
  }
  const name = `${CONTAINER_PREFIX}-${process.pid}-${Date.now().toString(36)}`;

  // Built as an argv array rather than a multi-line template: zx passes the
  // literal text to a shell verbatim, so an embedded newline would end the
  // command early and drop every flag after it.
  const runArgs = [
    'run',
    '-d',
    '--rm',
    '--name',
    name,
    // `<ip>::<containerPort>` is the one random-host-port form both runtimes
    // accept — podman rejects `0:5432` outright — and binding to loopback
    // keeps the throwaway database off every other interface.
    '-p',
    '127.0.0.1::5432',
    '-e',
    `POSTGRES_PASSWORD=${POSTGRES_PASSWORD}`,
    '-e',
    `POSTGRES_USER=${POSTGRES_USER}`,
    '-e',
    `POSTGRES_DB=${POSTGRES_DB}`,
    DB_TEST_PG_IMAGE,
  ];
  const run = await shell`${runtime} ${runArgs}`;
  if (run.exitCode !== 0) {
    throw new Error(
      `Failed to start the throwaway Postgres with ${runtime} (image ${DB_TEST_PG_IMAGE}):\n` +
        `${run.stderr.trim()}\n` +
        `Skip the real-Postgres suites deliberately with ${DB_SKIP_ENV}=1.`,
    );
  }

  const remove = async (): Promise<void> => {
    await shell`${runtime} rm -f ${name}`;
  };

  try {
    const port = await publishedPort(runtime, name);
    await waitForReady(runtime, name);
    process.env[DB_GATE_ENV] =
      `postgres://${POSTGRES_USER}:${POSTGRES_PASSWORD}@127.0.0.1:${port}/${POSTGRES_DB}`;
    console.log(
      `[db-test-postgres] ${runtime}: started ${name} on port ${port} ` +
        `for ${gated.length} gated suite(s)`,
    );
  } catch (err) {
    await remove();
    throw err;
  }

  return async () => {
    delete process.env[DB_GATE_ENV];
    await remove();
  };
}

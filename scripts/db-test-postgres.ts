/**
 * Shared vitest `globalSetup` that gives the real-Postgres suites a database.
 *
 * The real-SQL suites (migrations, repositories, stores and downstream) read
 * `KICI_TEST_ADMIN_DATABASE_URL` at module scope and skip when it is absent.
 * This setup starts a throwaway PostgreSQL container and sets the variable
 * before the workers fork, so `pnpm test` runs them instead of skipping green.
 *
 * The container starts only when the selected specs include a gated module, so
 * `vitest run src/routes` costs nothing. Each package references this file by
 * relative path from its vitest config.
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
 * Makes a leaked container identifiable by name. `--rm` plus the teardown
 * removes it on any ordinary exit (including a SIGINT vitest handles); a hard
 * kill leaves it running until the next setup reaps it, or
 * `podman/docker rm -f kici-db-test-pg-*` clears it by hand.
 */
const CONTAINER_PREFIX = 'kici-db-test-pg';

const POSTGRES_USER = 'testuser';
const POSTGRES_PASSWORD = 'testpw';
const POSTGRES_DB = 'postgres';

/** Readiness poll budget: 120 attempts at 500ms is a minute of cold start. */
const READY_ATTEMPTS = 120;
const READY_INTERVAL_MS = 500;

/**
 * Reap leaked containers older than this. A live test's container is seconds
 * to minutes old, never hours, so the gate cannot reach one.
 */
const STALE_CONTAINER_MAX_AGE_MS = 6 * 60 * 60 * 1000;

const shell = $({ nothrow: true, stdio: ['ignore', 'pipe', 'pipe'] });

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Vitest exposes the CLI's positional filters only as the undocumented
 * `filenamePattern` field: `config.filters` is always undefined, and
 * `getRelevantTestSpecifications()` with no argument returns every spec. A unit
 * test guards the field, so a vitest upgrade that moves it fails loudly.
 */
function cliFilters(project: TestProject): string[] {
  return (project.vitest as unknown as { filenamePattern?: string[] }).filenamePattern ?? [];
}

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
 * Polls `pg_isready` INSIDE the container, so the host needs no psql client.
 *
 * `-h 127.0.0.1` forces TCP: the entrypoint bootstraps against a socket-only
 * server (`listen_addresses=''`), so a socket probe can report ready while the
 * port the suites dial is still closed.
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
  // An operator-supplied server (the documented long-lived-server debugging
  // workflow) wins over a throwaway container.
  if (process.env[DB_GATE_ENV]) return noop;

  const specs = await project.vitest.getRelevantTestSpecifications(cliFilters(project));
  const gated = selectedDbGatedFiles(
    specs.map((spec) => spec.moduleId),
    (p) => readFileSync(p, 'utf-8'),
  );
  if (gated.length === 0) return noop;

  const runtime = resolveContainerRuntime();

  // Reap strays a hard-killed runner left behind. Best-effort: hygiene must
  // never fail a test run, so every call uses the nothrow `shell`.
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

  // An argv array, not a multi-line template: zx passes literal text to the
  // shell verbatim, so a newline would end the command and drop later flags.
  const runArgs = [
    'run',
    '-d',
    '--rm',
    '--name',
    name,
    // `<ip>::<containerPort>` is the one random-host-port form both runtimes
    // accept (podman rejects `0:5432`); loopback keeps it off other interfaces.
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

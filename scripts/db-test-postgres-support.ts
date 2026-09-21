/**
 * Side-effect-free helpers for the shared real-Postgres `globalSetup`
 * (`scripts/db-test-postgres.ts`).
 *
 * They live in their own module so the decision logic — which test modules
 * need a database, and which container runtime to use — is unit-testable
 * without starting anything.
 */
import { $ } from 'zx';

/**
 * Throwaway Postgres image for the gated suites. Pinned via `TS_CONST_PINS` in
 * hack/containers-lock.ts (identity dhi.io/postgres+debian13), so a lock bump
 * rewrites it in place.
 */
export const DB_TEST_PG_IMAGE = 'dhi.io/postgres:18.6-debian13';

/** Env var the gated suites read at module scope to decide whether to run. */
export const DB_GATE_ENV = 'KICI_TEST_ADMIN_DATABASE_URL';

/** Opt-out for a contributor with no container runtime. */
export const DB_SKIP_ENV = 'KICI_SKIP_DB_TESTS';

export type ContainerRuntime = 'podman' | 'docker';

/**
 * Both packages carry a Postgres-free static guard at
 * `src/db/migration-test-targets.test.ts`. Each reads every per-migration
 * test's source off disk and asserts it targets its own migration, so its own
 * source contains the gate env var as a string literal. Neither needs a
 * database — the shared path suffix excludes both, so running one alone never
 * spins a container.
 */
const STATIC_GUARD_SUFFIX = 'src/db/migration-test-targets.test.ts';

/** True when this test module actually needs a real database. */
export function isDbGatedSource(source: string, moduleId: string): boolean {
  if (moduleId.replaceAll('\\', '/').endsWith(STATIC_GUARD_SUFFIX)) return false;
  return source.includes(DB_GATE_ENV);
}

/**
 * Probe a runtime by asking it for its version.
 *
 * `nothrow` covers a non-zero exit; the try/catch covers the spawn-time
 * failure (binary not on PATH), which zx still raises synchronously.
 */
function defaultProbe(cmd: string): boolean {
  try {
    return (
      $.sync({ nothrow: true, stdio: ['ignore', 'pipe', 'pipe'] })`${cmd} version`.exitCode === 0
    );
  } catch {
    return false;
  }
}

/**
 * Resolve the container runtime explicitly.
 *
 * Deliberately NOT `podman … || docker …`: on a host with both, `podman ps`
 * exits 0 with empty output so the `||` never falls through and docker is never
 * seen (.claude/rules/e2e-executor-109.md). The primary dev machine is podman,
 * the E2E executor is Docker, so both must work.
 */
export function resolveContainerRuntime(
  probe: (cmd: string) => boolean = defaultProbe,
): ContainerRuntime {
  if (probe('podman')) return 'podman';
  if (probe('docker')) return 'docker';
  throw new Error(
    'No container runtime found. The real-Postgres test suites need podman or docker.\n' +
      `Install one, or skip those suites deliberately with ${DB_SKIP_ENV}=1.`,
  );
}

/**
 * Filter a selected spec list down to the modules that need a database.
 *
 * Matches on file CONTENT, not path: 49 of the 133 gated suites live outside
 * `db/` (platform notifications, dashboard routes, secrets, oidc, webhooks,
 * billing, auth), so a path glob would miss more than a third of them.
 *
 * A module that cannot be read is skipped rather than fatal: a stale spec entry
 * must not take down a run that would otherwise not need a database at all.
 */
export function selectedDbGatedFiles(
  moduleIds: string[],
  read: (path: string) => string,
): string[] {
  const out: string[] = [];
  for (const id of moduleIds) {
    let source: string;
    try {
      source = read(id);
    } catch {
      continue;
    }
    if (isDbGatedSource(source, id)) out.push(id);
  }
  return out;
}

/**
 * Shape of every throwaway container name: `kici-db-test-pg-<pid>-<base36 ms>`.
 * Anchored, and the pid group is `\d+` so the trailing group is unambiguously
 * the timestamp — a pid is also base36-parseable, and reading it as the age
 * would date a brand-new container to 1970 and reap it.
 */
const CONTAINER_NAME_RE = /^kici-db-test-pg-\d+-([0-9a-z]+)$/;

/**
 * Select leaked throwaway Postgres containers old enough to reap.
 *
 * The name carries its own creation time, so a stray can be aged without asking
 * the runtime — the same trick `kici-leak-sweep` uses for leaked
 * `kici-{orch,agent}-linux-e2e-*` units.
 *
 * A name that does not match, or whose timestamp does not parse, is NEVER
 * selected: killing a live test's database is far worse than leaving a stray
 * behind for the next run to collect. Strictly older than `maxAgeMs`, so a
 * container exactly at the threshold is kept.
 */
export function selectStaleDbTestContainers(
  names: string[],
  nowMs: number,
  maxAgeMs: number,
): string[] {
  return names.filter((name) => {
    const match = CONTAINER_NAME_RE.exec(name.trim());
    if (match === null) return false;
    const createdMs = Number.parseInt(match[1]!, 36);
    if (!Number.isFinite(createdMs) || createdMs <= 0) return false;
    return nowMs - createdMs > maxAgeMs;
  });
}

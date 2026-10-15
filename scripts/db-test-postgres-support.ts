/**
 * Side-effect-free helpers for `scripts/db-test-postgres.ts`, split out so the
 * decision logic is unit-testable without starting a container.
 */
import { $ } from 'zx';

/** The container-pin tooling rewrites this pin in place when the image is bumped. */
export const DB_TEST_PG_IMAGE = 'dhi.io/postgres:18.6-debian13';

/** Env var the gated suites read at module scope to decide whether to run. */
export const DB_GATE_ENV = 'KICI_TEST_ADMIN_DATABASE_URL';

/** Opt-out for a contributor with no container runtime. */
export const DB_SKIP_ENV = 'KICI_SKIP_DB_TESTS';

export type ContainerRuntime = 'podman' | 'docker';

/**
 * Each package's Postgres-free static guard at this path reads every
 * per-migration test's source, so it contains the gate env var as a literal.
 * Excluding the suffix keeps running a guard alone from spinning a container.
 */
const STATIC_GUARD_SUFFIX = 'src/db/migration-test-targets.test.ts';

/**
 * Source markers that mean a test module needs a real database: the gate env
 * var a hand-written suite reads, and the names of the suite harnesses from
 * `@kici-dev/test-support/test-db`, which read the env var on the suite's
 * behalf. Bare names, not `name(`: a call with a type argument
 * (`describeWithTestDb<Database>(`) has no `(` after the name.
 */
export const DB_GATED_MARKERS: readonly string[] = [DB_GATE_ENV, 'describeWithTestDb', 'useTestDb'];

export function isDbGatedSource(source: string, moduleId: string): boolean {
  if (moduleId.replaceAll('\\', '/').endsWith(STATIC_GUARD_SUFFIX)) return false;
  return DB_GATED_MARKERS.some((marker) => source.includes(marker));
}

/**
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
 * Deliberately NOT `podman … || docker …`: on a host with both, `podman ps`
 * exits 0 with empty output, so the `||` never reaches docker. A build host may
 * have either runtime.
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
 * Matches on file CONTENT, not path: many gated suites live outside `db/`
 * (notifications, routes, secrets, OIDC, webhooks, auth).
 *
 * An unreadable module is skipped, not fatal: a stale spec entry must not take
 * down a run that would otherwise not need a database.
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
 * Ages each container by the creation time in its name, without asking the runtime.
 *
 * A name that does not match, or whose timestamp does not parse, is NEVER
 * selected: killing a live test's database is far worse than leaving a stray
 * for the next run. Strictly older than `maxAgeMs`: a container exactly at the
 * threshold is kept.
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

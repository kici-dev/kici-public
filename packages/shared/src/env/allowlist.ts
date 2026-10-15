/**
 * Source of truth for the env-var allowlist: every env var read by KiCI's own
 * code MUST start with `KICI_`, except a fixed allowlist of OS / SDK names
 * KiCI consumes but does not own (PATH, AWS_*, REDIS_*, OTEL_*, etc.).
 *
 * Two artefacts read this file:
 *
 *   1. `packages/shared/src/env/env-rule-allowlist.test.ts` — a runtime
 *      backstop that matches every `process[.]env[.]NAME` access in the
 *      source tree against `IS_ALLOWED_ENV_NAME(NAME)`, catching reads the
 *      ESLint rule missed. It strips template-literal contents first, so
 *      workflow source embedded in fixture-emitting helpers does NOT count.
 *   2. `eslint.config.js` — an inline `no-restricted-syntax` rule that
 *      builds the same regex INLINE (it can't import a TS file at lint init),
 *      so any change here MUST be mirrored there. The backstop test fails
 *      loudly if the two drift.
 *
 * A new env var MUST use `KICI_*`: register it in the package's `defineEnv`
 * envMap and regenerate `docs/operator/env-reference.md`.
 */

/**
 * Anchored regex matching `KICI_*` plus the OS / SDK / external-system names
 * KiCI only consumes and so cannot prefix.
 *
 * Categories:
 *   - `KICI_*`            — every project-internal env var.
 *   - OS basics           — NODE_ENV, HOME, PATH, TZ, LANG, TMPDIR,
 *                           USER, USERNAME, SHELL, COMSPEC, PWD, OLDPWD,
 *                           HOSTNAME, PROCESSOR_ARCHITECTURE (Windows arch
 *                           hint the agent reads to pick the mise zip).
 *   - Terminal / display  — COLUMNS, LINES, TERM, COLORTERM, DISPLAY,
 *                           WAYLAND_DISPLAY, LOCALAPPDATA.
 *   - XDG basedir spec    — XDG_*.
 *   - npm / SSH wrappers  — INIT_CWD, npm_*, SSH_*.
 *   - CI provider hints   — CI, GITHUB_ACTIONS, GITHUB_ENV, GITHUB_OUTPUT,
 *                           GITHUB_PATH, GITHUB_STEP_SUMMARY, GITLAB_CI.
 *   - Cloud / SDK names   — AWS_*, REDIS_*, OTEL_*, STRIPE_*, HCLOUD_*, DOCKER_*,
 *                           CONTAINER_HOST.
 *   - git tooling         — GIT_* (git's own env-var family, e.g.
 *                           GIT_CONFIG_GLOBAL / GIT_SSH_COMMAND, that KiCI
 *                           sets to drive cloned / overlay workspaces).
 *   - Postgres libpq      — PGHOST, PGPORT, PGUSER, PGPASSWORD,
 *                           PGDATABASE, PGSERVICEFILE, PGSSLMODE.
 *   - Forgejo server      — FORGEJO_URL, FORGEJO_CONTAINER (Forgejo's
 *                           names, read by a Forgejo bootstrap script).
 *   - Keycloak admin CLI  — KEYCLOAK_* (Keycloak's unprefixed names, e.g.
 *                           `KEYCLOAK_BASE_URL`; Keycloak admin tooling
 *                           honours them as a fallback after
 *                           `KICI_KEYCLOAK_*`).
 *   - Vite client config  — VITE_* (Vite's prefix for vars exposed to
 *                           client bundles, e.g. `VITE_BASE`,
 *                           `VITE_DOCS_BASE_URL`).
 *   - Playwright runtime  — PLAYWRIGHT (test-runner-set switch the
 *                           dashboard's vite.config consults to disable
 *                           the dev proxy), HEADED (Playwright convention
 *                           for `--headed` runs).
 *   - Vitest runtime      — VITEST_* (vitest's own names, which it reads
 *                           after config resolution: VITEST_MAX_WORKERS
 *                           carries the per-process worker ceiling
 *                           `hack/lib/vitest-workers.ts` publishes, and
 *                           VITEST_POOL_ID marks a pool worker).
 */
const OS_SDK_ALLOWLIST_REGEX =
  /^(KICI_.*|NODE_ENV|HOME|PATH|TZ|LANG|TMPDIR|USER|USERNAME|SHELL|COMSPEC|PWD|OLDPWD|HOSTNAME|PROCESSOR_ARCHITECTURE|COLUMNS|LINES|TERM|COLORTERM|DISPLAY|WAYLAND_DISPLAY|LOCALAPPDATA|XDG_CACHE_HOME|XDG_CONFIG_HOME|XDG_DATA_HOME|XDG_RUNTIME_DIR|XDG_STATE_HOME|INIT_CWD|npm_.*|SSH_.*|CI|GITHUB_ACTIONS|GITHUB_ENV|GITHUB_OUTPUT|GITHUB_PATH|GITHUB_STEP_SUMMARY|GITLAB_CI|AWS_.*|REDIS_.*|OTEL_.*|STRIPE_.*|HCLOUD_.*|DOCKER_.*|GIT_.*|CONTAINER_HOST|container|PGHOST|PGPORT|PGUSER|PGPASSWORD|PGDATABASE|PGSERVICEFILE|PGSSLMODE|FORGEJO_URL|FORGEJO_CONTAINER|KEYCLOAK_.*|VITE_.*|VITEST_.*|PLAYWRIGHT|HEADED)$/;

/**
 * Whether `name` is allowed under the KiCI env-var convention.
 */
export function IS_ALLOWED_ENV_NAME(name: string): boolean {
  return OS_SDK_ALLOWLIST_REGEX.test(name);
}

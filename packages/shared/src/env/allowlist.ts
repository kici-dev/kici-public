/**
 * Source of truth for the env-var allowlist.
 *
 * KiCI's naming convention:
 *
 *   > Every env var read by KiCI's own code MUST start with `KICI_`,
 *   > except for a fixed allowlist of OS / SDK names that KiCI consumes
 *   > but does not own (PATH, AWS_*, REDIS_*, OTEL_*, etc.).
 *
 * Two artefacts read this file:
 *
 *   1. `packages/shared/src/env/env-rule-allowlist.test.ts` — a runtime
 *      backstop that walks the source tree and matches every
 *      `process[.]env[.]NAME` access against `IS_ALLOWED_ENV_NAME(NAME)`.
 *      Catches any read that the inline ESLint rule missed. The backstop
 *      strips template-literal contents before scanning, so workflow
 *      source code embedded in fixture-emitting helpers does NOT
 *      contribute to the read set.
 *   2. `eslint.config.js` — an inline `no-restricted-syntax` rule that
 *      mirrors the same regex at lint time. The eslint config builds the
 *      regex INLINE (it can't import from a TS file at lint init), so any
 *      change here MUST also be reflected there. The backstop test fails
 *      loudly if the two drift.
 *
 * The phased rename that introduced this rule (P0–P8) is complete: the
 * `MIGRATING_ENV_VARS` ratchet is gone and `KICI_*` is the only accepted
 * project-internal namespace. New env vars MUST use `KICI_*` — see
 * `.claude/rules/env-vars.md` for the convention and how to add one
 * (always `KICI_*`, register in the relevant package's `defineEnv`
 * envMap, regenerate `docs/operator/env-reference.md`, done).
 */

/**
 * Anchored regex matching the OS / SDK / external-system env var names
 * that KiCI is the *consumer* of. KiCI does not own these names, so it
 * can't prefix them. Plus the `KICI_*` prefix itself for everything we
 * do own.
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
 *   - Cloud / SDK names   — AWS_*, REDIS_*, OTEL_*, STRIPE_*, DOCKER_*,
 *                           CONTAINER_HOST.
 *   - git tooling         — GIT_* (git's own env-var family, e.g.
 *                           GIT_CONFIG_GLOBAL / GIT_SSH_COMMAND, that KiCI
 *                           sets to drive cloned / overlay workspaces).
 *   - Postgres libpq      — PGHOST, PGPORT, PGUSER, PGPASSWORD,
 *                           PGDATABASE, PGSERVICEFILE, PGSSLMODE.
 *   - Forgejo dev server  — FORGEJO_URL, FORGEJO_CONTAINER (read by the
 *                           staging Forgejo bootstrap script; conventional
 *                           names owned by Forgejo, not KiCI).
 *   - Keycloak admin CLI  — KEYCLOAK_* (Keycloak's own admin tooling and
 *                           docs use unprefixed `KEYCLOAK_BASE_URL`,
 *                           `KEYCLOAK_ADMIN_CLIENT_ID`,
 *                           `KEYCLOAK_ADMIN_CLIENT_SECRET`, etc. — the
 *                           E2E admin helpers honour those names as a
 *                           fallback after `KICI_KEYCLOAK_*`).
 *   - Vite client config  — VITE_* (Vite reserves this prefix for env
 *                           vars exposed to client bundles; `VITE_BASE`
 *                           and `VITE_DOCS_BASE_URL` flow through this
 *                           channel).
 *   - Playwright runtime  — PLAYWRIGHT (test-runner-set switch the
 *                           dashboard's vite.config consults to disable
 *                           the dev proxy), HEADED (Playwright convention
 *                           for `--headed` runs).
 */
export const OS_SDK_ALLOWLIST_REGEX =
  /^(KICI_.*|NODE_ENV|HOME|PATH|TZ|LANG|TMPDIR|USER|USERNAME|SHELL|COMSPEC|PWD|OLDPWD|HOSTNAME|PROCESSOR_ARCHITECTURE|COLUMNS|LINES|TERM|COLORTERM|DISPLAY|WAYLAND_DISPLAY|LOCALAPPDATA|XDG_CACHE_HOME|XDG_CONFIG_HOME|XDG_DATA_HOME|XDG_RUNTIME_DIR|XDG_STATE_HOME|INIT_CWD|npm_.*|SSH_.*|CI|GITHUB_ACTIONS|GITHUB_ENV|GITHUB_OUTPUT|GITHUB_PATH|GITHUB_STEP_SUMMARY|GITLAB_CI|AWS_.*|REDIS_.*|OTEL_.*|STRIPE_.*|DOCKER_.*|GIT_.*|CONTAINER_HOST|container|PGHOST|PGPORT|PGUSER|PGPASSWORD|PGDATABASE|PGSERVICEFILE|PGSSLMODE|FORGEJO_URL|FORGEJO_CONTAINER|KEYCLOAK_.*|VITE_.*|PLAYWRIGHT|HEADED)$/;

/**
 * Returns true when `name` is allowed under the KiCI env-var convention:
 * it matches the OS/SDK allowlist regex (which includes the `KICI_*`
 * prefix). The phased migration is complete; there is no longer a
 * separate "migrating" set.
 */
export function IS_ALLOWED_ENV_NAME(name: string): boolean {
  return OS_SDK_ALLOWLIST_REGEX.test(name);
}

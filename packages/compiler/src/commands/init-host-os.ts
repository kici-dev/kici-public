/**
 * Host-OS helpers for `kici init`.
 *
 * The starter templates target `kici:os:linux`. On a macOS or Windows host that
 * label matches no local dev-plane agent, so the first `kici run push --local`
 * dispatches nothing. These helpers rewrite the scaffolded `runsOn` to the
 * host's own `kici:os:*` label so the first run lands, mirroring how `kici init`
 * already rewrites the default branch.
 */

import { deriveOsArchLabels } from '@kici-dev/engine';

const OS_LABEL_PREFIX = 'kici:os:';

/**
 * The primary `kici:os:*` label the host reports (linux→kici:os:linux,
 * darwin→kici:os:macos, win32→kici:os:windows). Derived from the engine's
 * canonical mapping — the same derivation the local dev-plane routing uses — so
 * the value is never hand-spelled here and always matches what the plane can
 * satisfy.
 */
export function primaryHostOsLabel(platform: string, arch: string): string {
  const osLabel = deriveOsArchLabels(platform, arch).find((l) => l.startsWith(OS_LABEL_PREFIX));
  return osLabel ?? `${OS_LABEL_PREFIX}${platform}`;
}

/**
 * Rewrite a template's `'kici:os:linux'` runsOn to the host's primary OS label.
 * A no-op on a Linux host (the templates already target it).
 */
export function rewriteRunsOnForHost(content: string, platform: string, arch: string): string {
  const hostLabel = primaryHostOsLabel(platform, arch);
  if (hostLabel === 'kici:os:linux') return content;
  return content.replaceAll(`'kici:os:linux'`, `'${hostLabel}'`);
}

/**
 * Whether to offer the post-init `Run it now?` prompt: interactive (TTY, not CI)
 * and with dependencies installed (not `--mjs`, not `--skip-install`), so the
 * offered `kici run push --local` can compile the workflow it just scaffolded.
 */
export function shouldOfferFirstRun(env: {
  isTTY: boolean;
  ci: boolean;
  mjs: boolean;
  skipInstall: boolean;
}): boolean {
  return env.isTTY && !env.ci && !env.mjs && !env.skipInstall;
}

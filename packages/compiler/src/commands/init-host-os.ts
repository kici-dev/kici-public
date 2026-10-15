/**
 * Host-OS helpers for `kici init`. The starter templates target
 * `kici:os:linux`, which matches no local dev-plane agent on macOS or Windows,
 * so the scaffolded `runsOn` is rewritten to the host's own label and the first
 * `kici run push --local` lands, mirroring how `kici init` rewrites the
 * default branch.
 */

import { deriveOsArchLabels } from '@kici-dev/engine';

const OS_LABEL_PREFIX = 'kici:os:';

/**
 * The host's primary `kici:os:*` label (darwin→kici:os:macos,
 * win32→kici:os:windows), from the engine mapping the dev-plane routing uses,
 * so it always matches what the plane can satisfy.
 */
export function primaryHostOsLabel(platform: string, arch: string): string {
  const osLabel = deriveOsArchLabels(platform, arch).find((l) => l.startsWith(OS_LABEL_PREFIX));
  return osLabel ?? `${OS_LABEL_PREFIX}${platform}`;
}

/** A no-op on a Linux host. */
export function rewriteRunsOnForHost(content: string, platform: string, arch: string): string {
  const hostLabel = primaryHostOsLabel(platform, arch);
  if (hostLabel === 'kici:os:linux') return content;
  return content.replaceAll(`'kici:os:linux'`, `'${hostLabel}'`);
}

/**
 * Offer `Run it now?` only when interactive (TTY, not CI) and with dependencies
 * installed (not `--mjs`, not `--skip-install`), so the run can compile.
 */
export function shouldOfferFirstRun(env: {
  isTTY: boolean;
  ci: boolean;
  mjs: boolean;
  skipInstall: boolean;
}): boolean {
  return env.isTTY && !env.ci && !env.mjs && !env.skipInstall;
}

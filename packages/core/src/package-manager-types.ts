/**
 * Package-manager identity — the enum and pure helpers, with no filesystem
 * dependency. Kept separate from `package-manager.ts` (which reads the disk to
 * detect the manager) so browser-safe consumers — the engine protocol schemas
 * and lock-file types the dashboard transitively imports — can reference the
 * enum without pulling `node:fs` into a browser bundle.
 */

/** Supported package managers. */
export enum PackageManager {
  Npm = 'npm',
  Pnpm = 'pnpm',
  Yarn = 'yarn',
}

/** All package-manager identifiers, for flag/schema validation. */
export const PACKAGE_MANAGERS: readonly PackageManager[] = Object.values(PackageManager);

/**
 * yarn flavor — classic (v1) vs berry (v2+). The `yarn` binary and `yarn.lock`
 * filename are shared between the two, but their install model differs
 * (`.npmrc` vs `.yarnrc.yml`, no-`workspace:` vs native `workspace:`/`portal:`),
 * so the dep-handling code branches on this flavor when the detected
 * {@link PackageManager} is `Yarn`. This is a second axis on top of
 * `PackageManager`, not a member of it — the name axis (`parsePackageManager`)
 * stays version-free.
 */
export enum YarnFlavor {
  Classic = 'classic',
  Berry = 'berry',
}

/**
 * Parse a raw string into a {@link PackageManager}, or `null` when it does not
 * name a supported manager. Accepts bare names (`pnpm`) used by the CLI flag
 * and the env-var / packageManager-field tiers.
 */
export function parsePackageManager(value: string): PackageManager | null {
  switch (value) {
    case PackageManager.Npm:
      return PackageManager.Npm;
    case PackageManager.Pnpm:
      return PackageManager.Pnpm;
    case PackageManager.Yarn:
      return PackageManager.Yarn;
    default:
      return null;
  }
}

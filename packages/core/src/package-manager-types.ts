/**
 * Package-manager enum and pure helpers, split from the disk-reading
 * `package-manager.ts` so browser-safe consumers (engine protocol schemas and
 * lock-file types the dashboard imports) avoid pulling `node:fs`.
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
 * yarn classic (v1) vs berry (v2+): same binary and `yarn.lock`, different
 * install model (`.npmrc` vs `.yarnrc.yml`, no-`workspace:` vs native
 * `workspace:`/`portal:`). A second axis beside {@link PackageManager}, so the
 * name axis (`parsePackageManager`) stays version-free.
 */
export enum YarnFlavor {
  Classic = 'classic',
  Berry = 'berry',
}

/** Parse a bare name (`pnpm`) into a {@link PackageManager}, or `null` when unsupported. */
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

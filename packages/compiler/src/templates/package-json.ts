/**
 * Package.json template generator for kici init command
 *
 * Generates package.json for .kici/ directory in TypeScript mode.
 * SDK is a devDependency resolved from the npm registry
 * (or a private Verdaccio instance when .npmrc scopes the registry).
 * The compiler is invoked via npx (not installed as a dependency).
 */

declare const KICI_VERSION: string;
const sdkVersion = typeof KICI_VERSION !== 'undefined' ? KICI_VERSION : '0.0.1';

/**
 * The npm version spec the scaffold pins `@kici-dev/sdk` to.
 *
 * @param devMode - When true, the `latest` dist-tag, so npm resolves whatever
 *   build the dev registry (Verdaccio) currently publishes. Dev builds are
 *   prereleases such as `0.8.0-9726`, and no semver range reaches them: a
 *   prerelease only satisfies a comparator with the same major.minor.patch, so
 *   `^0.0.1` misses every one and `>=0.0.1-0` misses every one past 0.0.1.
 *   A dist-tag is resolved by name, never by range, so it follows the counter.
 */
export function sdkDependencyRange(devMode = false): string {
  return devMode ? 'latest' : `^${sdkVersion}`;
}

/**
 * The TypeScript range scaffolded into a `.kici` workspace. Pinned to the major
 * the compiler is built against so `kici compile --check` (and the `typecheck`
 * script) run the same tsc the compiler expects. Same range in dev and prod
 * mode — TypeScript is a public npm package, not a Verdaccio prerelease.
 */
export const TYPESCRIPT_RANGE = '^6.0.3';

/**
 * Generate package.json content for .kici/ directory
 *
 * @param devMode - When true, pins the SDK to the `latest` dist-tag so npm
 *   resolves the dev registry's newest prerelease build (see sdkDependencyRange).
 * @returns JSON string with proper formatting (2-space indent, trailing newline)
 */
export function generatePackageJson(devMode = false): string {
  const pkg = {
    name: '@kici-dev/workflows',
    private: true,
    type: 'module' as const,
    scripts: {
      compile: 'npx --yes kici@latest compile',
      typecheck: 'tsc --noEmit',
    },
    devDependencies: {
      '@kici-dev/sdk': sdkDependencyRange(devMode),
      typescript: TYPESCRIPT_RANGE,
    },
  };

  return JSON.stringify(pkg, null, 2) + '\n';
}

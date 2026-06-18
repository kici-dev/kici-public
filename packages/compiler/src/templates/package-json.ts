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
 * Generate package.json content for .kici/ directory
 *
 * @param devMode - When true, uses a prerelease-compatible version range
 *   (`>=0.0.1-0`) so npm resolves Verdaccio's prerelease builds (e.g. 0.0.1-2856).
 *   Semver `^0.0.1` does NOT match prereleases, causing 404s on Verdaccio.
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
      '@kici-dev/sdk': devMode ? '>=0.0.1-0' : `^${sdkVersion}`,
    },
  };

  return JSON.stringify(pkg, null, 2) + '\n';
}

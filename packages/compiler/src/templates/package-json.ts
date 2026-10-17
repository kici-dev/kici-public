/**
 * Package.json template generator for kici init command
 *
 * Generates package.json for the .kici/ directory in TypeScript mode. The SDK
 * and TypeScript are devDependencies resolved from the npm registry (or a
 * private registry when .npmrc scopes it). The compiler is not a dependency:
 * the `compile` script runs it through npx, at the version of the CLI that
 * scaffolded the project.
 */

import { VersionPin } from './version-pin.js';

declare const KICI_VERSION: string;

/** The version of the running `kici` CLI: the version the scaffold pins KiCI packages to. */
export function scaffoldKiciVersion(): string {
  return typeof KICI_VERSION !== 'undefined' ? KICI_VERSION : '0.0.1';
}

/**
 * The TypeScript version the compiler is built against, so `kici compile
 * --check` and the `typecheck` script run the tsc the compiler expects.
 */
const TYPESCRIPT_VERSION = '6.0.3';

/** `version` as an exact version or a caret range. */
function pinnedVersion(version: string, pin: VersionPin): string {
  return pin === VersionPin.Exact ? version : `^${version}`;
}

/**
 * The npm version spec the scaffold pins `@kici-dev/sdk` to.
 *
 * `VersionPin.Latest` writes the `latest` dist-tag, so npm resolves whatever
 * build the dev registry currently publishes. Dev builds are prereleases such as
 * `0.8.0-9726`, and no semver range reaches them: a prerelease only satisfies a
 * comparator with the same major.minor.patch. A dist-tag is resolved by name,
 * never by range, so it follows the counter.
 */
export function sdkDependencyRange(pin: VersionPin): string {
  return pin === VersionPin.Latest ? 'latest' : pinnedVersion(scaffoldKiciVersion(), pin);
}

/**
 * The `compile` script. Outside development mode it runs the CLI version the
 * SDK is pinned to, so the lock file always comes from the same KiCI version as
 * the SDK, never from a newer compiler whose lock file an older orchestrator
 * rejects.
 */
function compileScript(pin: VersionPin): string {
  const spec = pin === VersionPin.Latest ? 'latest' : scaffoldKiciVersion();
  return `npx --yes kici@${spec} compile`;
}

/**
 * Generate package.json content for the .kici/ directory.
 *
 * @param pin - How the SDK, TypeScript and the compile script are versioned
 *   (`resolveVersionPin` in `version-pin.ts`). TypeScript is a public npm
 *   package, so it stays a caret range in development mode.
 * @returns JSON string with proper formatting (2-space indent, trailing newline)
 */
export function generatePackageJson(pin: VersionPin): string {
  const pkg = {
    name: '@kici-dev/workflows',
    // yarn classic ignores a workspace member that declares no version.
    version: '0.0.0',
    private: true,
    type: 'module' as const,
    scripts: {
      compile: compileScript(pin),
      typecheck: 'tsc --noEmit',
    },
    devDependencies: {
      '@kici-dev/sdk': sdkDependencyRange(pin),
      typescript: pinnedVersion(TYPESCRIPT_VERSION, pin),
    },
  };

  return JSON.stringify(pkg, null, 2) + '\n';
}

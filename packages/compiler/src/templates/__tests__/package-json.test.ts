import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { generatePackageJson, sdkDependencyRange } from '../package-json.js';
import { VersionPin } from '../version-pin.js';

const CLI_VERSION = '0.17.0';

interface ScaffoldedPackageJson {
  name: string;
  private: boolean;
  type: string;
  scripts: Record<string, string>;
  devDependencies: Record<string, string>;
}

function scaffold(pin: VersionPin): ScaffoldedPackageJson {
  return JSON.parse(generatePackageJson(pin)) as ScaffoldedPackageJson;
}

beforeEach(() => {
  vi.stubGlobal('KICI_VERSION', CLI_VERSION);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('package-json template', () => {
  it.each([
    [VersionPin.Caret, `^${CLI_VERSION}`, '^6.0.3', `npx --yes kici@${CLI_VERSION} compile`],
    [VersionPin.Exact, CLI_VERSION, '6.0.3', `npx --yes kici@${CLI_VERSION} compile`],
    [VersionPin.Latest, 'latest', '^6.0.3', 'npx --yes kici@latest compile'],
  ])('%s: SDK %s, TypeScript %s, compile script %s', (pin, sdk, typescript, compile) => {
    const pkg = scaffold(pin);
    expect(pkg.devDependencies['@kici-dev/sdk']).toBe(sdk);
    expect(pkg.devDependencies.typescript).toBe(typescript);
    expect(pkg.scripts.compile).toBe(compile);
    expect(pkg.devDependencies['@kici-dev/compiler']).toBeUndefined();
  });

  it.each([VersionPin.Caret, VersionPin.Exact])(
    '%s: the compile script runs the SDK version',
    (pin) => {
      const pkg = scaffold(pin);
      const sdkVersion = pkg.devDependencies['@kici-dev/sdk'].replace(/^\^/, '');
      // fails-when: the compile script floats on a dist-tag while the SDK is pinned,
      // so a newer compiler writes a lock file the project's orchestrator rejects
      expect(pkg.scripts.compile).toBe(`npx --yes kici@${sdkVersion} compile`);
    },
  );

  it('keeps the latest dist-tag for the SDK in development mode', () => {
    // breaks-if-wrong: dev builds are prereleases (0.8.0-9726 and later), and a
    // prerelease only satisfies a comparator with the same major.minor.patch, so
    // no range reaches them; a dist-tag resolves by name
    expect(sdkDependencyRange(VersionPin.Latest)).toBe('latest');
  });

  it('ends with a trailing newline and keeps the top-level shape', () => {
    for (const pin of [VersionPin.Caret, VersionPin.Exact, VersionPin.Latest]) {
      const out = generatePackageJson(pin);
      expect(out.endsWith('\n')).toBe(true);
      expect(JSON.parse(out)).toMatchObject({
        name: '@kici-dev/workflows',
        private: true,
        type: 'module',
        scripts: { typecheck: 'tsc --noEmit' },
      });
    }
  });
});

describe('package-json template version', () => {
  it('declares a version, which yarn classic requires of every workspace member', () => {
    // fails-when: the manifest has no version, so yarn classic prints "Missing version
    // in workspace at .kici, ignoring" and a workspace member installs nothing
    for (const pin of [VersionPin.Caret, VersionPin.Exact, VersionPin.Latest]) {
      expect(JSON.parse(generatePackageJson(pin)).version).toBe('0.0.0');
    }
  });
});

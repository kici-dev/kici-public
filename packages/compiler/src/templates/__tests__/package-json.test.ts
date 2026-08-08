import { describe, it, expect } from 'vitest';
import { generatePackageJson, sdkDependencyRange } from '../package-json.js';

describe('sdkDependencyRange', () => {
  it('returns a prerelease-compatible range in dev mode', () => {
    expect(sdkDependencyRange(true)).toBe('>=0.0.1-0');
  });

  it('returns a caret range in production mode', () => {
    expect(sdkDependencyRange(false)).toMatch(/^\^\d+\.\d+\.\d+/);
  });

  it('is the same range generatePackageJson embeds', () => {
    const prod = JSON.parse(generatePackageJson(false));
    expect(prod.devDependencies['@kici-dev/sdk']).toBe(sdkDependencyRange(false));
    const dev = JSON.parse(generatePackageJson(true));
    expect(dev.devDependencies['@kici-dev/sdk']).toBe(sdkDependencyRange(true));
  });
});

describe('package-json template', () => {
  it('emits a caret-semver SDK pin in production mode', () => {
    const out = generatePackageJson(false);
    const parsed = JSON.parse(out);
    const sdkPin = parsed.devDependencies['@kici-dev/sdk'];
    // When built via build-ts.mjs the rolldown define inlines KICI_VERSION,
    // so the pin reflects the current workspace version. When this test runs
    // from source via vitest (which reads the .ts directly), KICI_VERSION is
    // undefined at runtime and the source falls through to the '0.0.1'
    // fallback. Either way the shape is caret + semver.
    expect(sdkPin).toMatch(/^\^\d+\.\d+\.\d+/);
  });

  it('emits the Verdaccio-compatible prerelease range in dev mode', () => {
    const out = generatePackageJson(true);
    const parsed = JSON.parse(out);
    expect(parsed.devDependencies['@kici-dev/sdk']).toBe('>=0.0.1-0');
  });

  it('ends with a trailing newline', () => {
    expect(generatePackageJson(false).endsWith('\n')).toBe(true);
    expect(generatePackageJson(true).endsWith('\n')).toBe(true);
  });

  it('parses as valid JSON with the expected top-level keys', () => {
    const parsed = JSON.parse(generatePackageJson(false));
    expect(parsed).toMatchObject({
      name: '@kici-dev/workflows',
      private: true,
      type: 'module',
    });
    expect(parsed.scripts).toBeDefined();
    expect(parsed.scripts.compile).toBeDefined();
    expect(parsed.scripts.typecheck).toBeDefined();
    expect(parsed.devDependencies).toBeDefined();
    expect(parsed.devDependencies['@kici-dev/sdk']).toBeDefined();
  });

  it('scaffolds typescript so --check / the typecheck script can run', () => {
    const prod = JSON.parse(generatePackageJson(false));
    expect(prod.devDependencies.typescript).toBeDefined();
    expect(prod.devDependencies.typescript).toMatch(/^\^\d+\.\d+\.\d+/);
    const dev = JSON.parse(generatePackageJson(true));
    expect(dev.devDependencies.typescript).toBe(prod.devDependencies.typescript);
  });
});

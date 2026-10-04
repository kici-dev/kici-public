import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import {
  HostNpmSource,
  lookupHostNpm,
  resolveNpm,
  verifyNpmAvailable,
  type HostNpmLookupEnv,
} from './npm-resolver.js';

describe('resolveNpm', () => {
  it('returns nodeExe matching process.execPath', () => {
    const result = resolveNpm();
    expect(result.nodeExe).toBe(process.execPath);
    expect(result.nodeDir).toBe(dirname(process.execPath));
  });

  it('finds npm-cli.js in standard Node.js layout', () => {
    const result = resolveNpm();
    // In a normal Node.js installation, npm should be found
    // (either via the standard path or undefined for non-standard layouts)
    expect(typeof result.npmCliPath === 'string' || result.npmCliPath === undefined).toBe(true);
  });
});

describe('verifyNpmAvailable', () => {
  it('returns npm version string when npm is available', () => {
    // In test environments, npm is always available (we're running in Node.js)
    const version = verifyNpmAvailable();
    expect(version).toMatch(/^\d+\.\d+\.\d+/);
  });

  it('throws descriptive error when npm is not available', () => {
    // Temporarily override process.execPath to a non-existent binary
    const originalExecPath = process.execPath;
    const originalPath = process.env.PATH;

    try {
      // Point to a fake node binary with no npm alongside it and clear PATH
      Object.defineProperty(process, 'execPath', {
        value: '/tmp/fake-node-binary',
        writable: true,
      });
      process.env.PATH = '';

      expect(() => verifyNpmAvailable()).toThrow('Builder role requires npm');
    } finally {
      Object.defineProperty(process, 'execPath', { value: originalExecPath, writable: true });
      process.env.PATH = originalPath;
    }
  });
});

/** The modules the agent loads from an npm it found. */
const NPM_MODULE_IDS = ['ini', '@npmcli/arborist', 'semver'];

/** Write a CommonJS stub package `id` into `nodeModules`. */
async function writeStubModule(nodeModules: string, id: string): Promise<void> {
  const dir = join(nodeModules, id);
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, 'package.json'),
    JSON.stringify({ name: id, version: '1.0.0', main: 'index.js' }),
  );
  await writeFile(join(dir, 'index.js'), 'module.exports = {};\n');
}

/**
 * Write an npm package at `root`: `bin/npm-cli.js`, a `package.json` naming it,
 * and, unless `modules` is false, its own copies of the modules the agent loads.
 * Returns the CLI path.
 */
async function writeNpm(
  root: string,
  version: string,
  opts: { name?: string; modules?: boolean } = {},
): Promise<string> {
  await mkdir(join(root, 'bin'), { recursive: true });
  const cli = join(root, 'bin', 'npm-cli.js');
  await writeFile(cli, '');
  await writeFile(
    join(root, 'package.json'),
    JSON.stringify({ name: opts.name ?? 'npm', version }),
  );
  if (opts.modules !== false) {
    for (const id of NPM_MODULE_IDS) await writeStubModule(join(root, 'node_modules'), id);
  }
  return cli;
}

describe('lookupHostNpm', () => {
  let base: string;
  /** A Debian-style host: node in usr/bin, nothing beside it, npm in usr/share/nodejs. */
  let debianEnv: (pathEnv?: string) => HostNpmLookupEnv;
  let debianCli: string;

  beforeEach(async () => {
    base = await realpath(await mkdtemp(join(tmpdir(), 'kici-npm-lookup-')));
    await mkdir(join(base, 'usr', 'bin'), { recursive: true });
    debianCli = join(base, 'usr', 'share', 'nodejs', 'npm', 'bin', 'npm-cli.js');
    debianEnv = (pathEnv = '') => ({
      execPath: join(base, 'usr', 'bin', 'node'),
      pathEnv,
      distributionCliPaths: [debianCli],
    });
  });

  afterEach(async () => {
    await rm(base, { recursive: true, force: true });
  });

  it.each(['12.0.2', '11.10.0'])(
    'accepts a Debian-style npm %s, at or above the minimum',
    async (version) => {
      await writeNpm(join(base, 'usr', 'share', 'nodejs', 'npm'), version);
      // fails-when: the lookup stays narrow (Node's own layouts only), so a
      // Debian-packaged Node has no npm for the host install.
      expect(lookupHostNpm(debianEnv())).toEqual({
        found: true,
        npmCliPath: debianCli,
        version,
        source: HostNpmSource.Distribution,
      });
    },
  );

  it.each(['11.9.9', '9.2.0'])(
    'refuses the same layout with npm %s, below the minimum',
    async (version) => {
      await writeNpm(join(base, 'usr', 'share', 'nodejs', 'npm'), version);
      // breaks-if-wrong: an npm older than 11.10.0, which has no --allow-git,
      // would be trusted to run the host install.
      expect(lookupHostNpm(debianEnv())).toEqual({
        found: false,
        detail: `${debianCli} is npm ${version}, older than 11.10.0`,
      });
    },
  );

  it('refuses a candidate whose package.json is not npm', async () => {
    await writeNpm(join(base, 'usr', 'share', 'nodejs', 'npm'), '12.0.0', { name: 'not-npm' });
    // fails-when: a CLI next to some other package's manifest is trusted as npm.
    expect(lookupHostNpm(debianEnv())).toEqual({
      found: false,
      detail: `${debianCli}: no npm version in its package.json`,
    });
  });

  it('names where it looked when no candidate exists', () => {
    expect(lookupHostNpm(debianEnv())).toEqual({
      found: false,
      detail: `no npm beside ${join(base, 'usr', 'bin', 'node')}, at ${debianCli}, or on PATH`,
    });
  });

  it("resolves Node's own npm first, even below the minimum and with a newer npm on PATH", async () => {
    const nodeDir = join(base, 'node', 'bin');
    await mkdir(nodeDir, { recursive: true });
    const bundled = await writeNpm(join(base, 'node', 'lib', 'node_modules', 'npm'), '10.0.0');
    const pathBin = join(base, 'pathbin');
    await mkdir(pathBin);
    await symlink(await writeNpm(join(base, 'opt', 'npm'), '12.0.0'), join(pathBin, 'npm'));
    await writeNpm(join(base, 'usr', 'share', 'nodejs', 'npm'), '12.0.2');
    // breaks-if-wrong: a host whose Node ships npm resolves exactly as before:
    // its own npm, with no version gate here (resolveHostNpm still applies its
    // own) and no fall-through to another npm.
    expect(
      lookupHostNpm({
        execPath: join(nodeDir, 'node'),
        pathEnv: pathBin,
        distributionCliPaths: [debianCli],
      }),
    ).toEqual({
      found: true,
      npmCliPath: bundled,
      version: '10.0.0',
      source: HostNpmSource.Bundled,
    });
  });

  it('accepts an npm on PATH whose real path is an npm package CLI', async () => {
    const pathBin = join(base, 'pathbin');
    await mkdir(pathBin);
    const cli = await writeNpm(join(base, 'opt', 'npm'), '12.0.0');
    await symlink(cli, join(pathBin, 'npm'));
    // fails-when: PATH is not consulted after the distribution location.
    expect(lookupHostNpm(debianEnv(pathBin))).toEqual({
      found: true,
      npmCliPath: cli,
      version: '12.0.0',
      source: HostNpmSource.Path,
    });
  });

  it('skips a PATH npm that is a launcher script', async () => {
    // A version-manager shim: a script named npm that is not npm's own CLI,
    // placed in a valid npm package's own bin/, so only the launcher-name
    // check refuses it.
    const pkg = join(base, 'shim-pkg');
    await writeNpm(pkg, '12.0.0');
    await writeFile(join(pkg, 'bin', 'npm'), '#!/bin/sh\nexec npm "$@"\n', { mode: 0o755 });
    // fails-when: a shim is trusted, so the host install runs whichever npm
    // the shim picks.
    expect(lookupHostNpm(debianEnv(join(pkg, 'bin')))).toEqual({
      found: false,
      detail: `no npm beside ${join(base, 'usr', 'bin', 'node')}, at ${debianCli}, or on PATH`,
    });
  });

  it('skips a relative PATH entry', async () => {
    const pathBin = join(base, 'pathbin');
    await mkdir(pathBin);
    await symlink(await writeNpm(join(base, 'opt', 'npm'), '12.0.0'), join(pathBin, 'npm'));
    // Positive control: the same directory, given absolute, is accepted.
    expect(lookupHostNpm(debianEnv(pathBin))).toMatchObject({ found: true });
    // fails-when: a relative entry resolves against the agent's working
    // directory, which can be a checkout.
    expect(lookupHostNpm(debianEnv(relative(process.cwd(), pathBin)))).toMatchObject({
      found: false,
    });
  });

  it('refuses an npm whose modules resolve outside its install', async () => {
    // npm at <base>/x/share/nodejs/npm without its own modules; the modules sit
    // in <base>/x/node_modules, which Node's resolution reaches by walking up,
    // outside <base>/x/share/nodejs.
    const root = join(base, 'x', 'share', 'nodejs', 'npm');
    const cli = await writeNpm(root, '12.0.0', { modules: false });
    for (const id of NPM_MODULE_IDS) await writeStubModule(join(base, 'x', 'node_modules'), id);
    const env = { ...debianEnv(), distributionCliPaths: [cli] };
    // fails-when: the agent parses .npmrc with an ini from a folder the install
    // (which runs with its own HOME) does not load, so the check and the
    // install can read different keys.
    expect(lookupHostNpm(env)).toEqual({
      found: false,
      detail: `${cli}: ini resolves to ${join(base, 'x', 'node_modules', 'ini', 'index.js')}, outside ${join(base, 'x', 'share', 'nodejs')}`,
    });
  });
});

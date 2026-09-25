import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { c as tarCreate } from 'tar';
import { PackageManager } from '@kici-dev/shared/package-manager';
import {
  HostInstallRefusal,
  checkHostInstallEligibility,
  type HostInstallPlan,
} from './host-install-eligibility.js';
import {
  checkLockedInstall,
  findUnpinnedDependency,
  findUnregisteredPackage,
  npmLockReader,
  type LockEdge,
  type LockNode,
  type LockTree,
  type NpmLockReader,
} from './host-install-lockfile.js';
import {
  NpmInstallCommand,
  buildHostInstallArgs,
  resolveHostNpm,
  runHostIsolatedInstall,
  type HostInstallTool,
} from './host-isolated-install.js';

const execFileAsync = promisify(execFile);

/** npm too old for `--allow-remote`: the host install runs `npm ci`. */
const CI_NPM_VERSION = '11.12.1';

const CI_TOOL: HostInstallTool = {
  packageManager: PackageManager.Npm,
  nodeExe: '/opt/node/bin/node',
  script: '/opt/node/lib/node_modules/npm/bin/npm-cli.js',
  version: CI_NPM_VERSION,
};

const NPMRC: HostInstallPlan['npmrc'] = {
  ini: { decode: () => ({}), encode: () => '' },
  operator: {},
  repo: {},
};

/** The one registry the unit cases allow. */
const REGISTRY = new URL('https://registry.example.com/');

function planWith(lockfile: string | null): HostInstallPlan {
  return { packageManager: PackageManager.Npm, lockfile, registries: [REGISTRY], npmrc: NPMRC };
}

function edge(name: string, overrides: Partial<LockEdge> = {}): LockEdge {
  return { name, type: 'prod', spec: '^1.0.0', to: {}, valid: true, ...overrides };
}

/** A registry tarball URL for the package at `location`, on {@link REGISTRY}. */
function tarballAt(location: string): string {
  const name = location.split('node_modules/').pop()!;
  return `${REGISTRY.href}${name}/-/${name}-1.0.0.tgz`;
}

/**
 * A tree whose packages default to what npm writes for a registry package:
 * version `1.0.0`, resolved from a tarball on {@link REGISTRY}. The project
 * itself (location `''`) has no `resolved`.
 */
function tree(nodes: Array<Partial<LockNode> & { edges?: LockEdge[] }>): LockTree {
  return {
    inventory: new Map(
      nodes.map((n, i) => {
        const location = n.location ?? '';
        const node: LockNode = {
          location,
          hasShrinkwrap: n.hasShrinkwrap ?? false,
          resolved: 'resolved' in n ? (n.resolved ?? null) : location ? tarballAt(location) : null,
          version: n.version ?? '1.0.0',
          inDepBundle: n.inDepBundle ?? false,
          edgesOut: new Map((n.edges ?? []).map((e) => [e.name, e])),
        };
        return [String(i), node];
      }),
    ),
  };
}

/** A strict `major.minor.patch[-pre][+build]` check standing in for npm's semver. */
const isVersion = (v: string): boolean => /^\d+\.\d+\.\d+(-[\w.]+)?(\+[\w.]+)?$/.test(v);

/** A reader handing back `load`'s tree, with {@link isVersion}. */
function readerOf(load: () => Promise<LockTree>): NpmLockReader {
  return { loadTree: load, isVersion };
}

describe('findUnpinnedDependency', () => {
  it('passes a tree whose every edge resolves to a package that satisfies it', () => {
    // breaks-if-wrong: a complete lockfile must keep the install on the host.
    expect(
      findUnpinnedDependency(
        tree([{ edges: [edge('foo')] }, { location: 'node_modules/foo', edges: [edge('bar')] }]),
      ),
    ).toBeNull();
  });

  it('leaves a missing optional peer alone, which npm never resolves', () => {
    expect(
      findUnpinnedDependency(tree([{ edges: [edge('p', { type: 'peerOptional', to: null })] }])),
    ).toBeNull();
  });

  it.each<[string, LockTree, RegExp]>([
    [
      'a missing dependency',
      tree([{ location: 'node_modules/foo', edges: [edge('bar', { to: null })] }]),
      /node_modules\/foo depends on bar@\^1\.0\.0, which the lockfile does not pin/,
    ],
    [
      'a missing optional dependency',
      tree([{ edges: [edge('baz', { type: 'optional', to: null })] }]),
      /the project depends on baz/,
    ],
    [
      'a locked package that does not satisfy its edge',
      tree([{ edges: [edge('foo', { valid: false })] }]),
      /which the locked foo does not satisfy/,
    ],
    [
      'a package that ships its own shrinkwrap',
      tree([{ location: 'node_modules/foo', hasShrinkwrap: true }]),
      /node_modules\/foo ships its own npm-shrinkwrap\.json/,
    ],
  ])('refuses %s', (_label, input, detail) => {
    // fails-when: the edge or node is skipped, so npm ci resolves it itself.
    expect(findUnpinnedDependency(input)).toMatch(detail);
  });
});

describe('findUnregisteredPackage', () => {
  const scan = (t: LockTree) => findUnregisteredPackage(t, [REGISTRY], isVersion);

  it('passes registry packages and a package bundled in its parent, which has no resolved', () => {
    // breaks-if-wrong: the lockfile npm writes for a registry-only project,
    // including a dependency's bundleDependencies, keeps the install on the host.
    expect(
      scan(
        tree([
          { version: '' },
          { location: 'node_modules/foo', version: '1.2.3-rc.1+build.5' },
          { location: 'node_modules/foo/node_modules/b', resolved: null, inDepBundle: true },
        ]),
      ),
    ).toBeNull();
  });

  it.each<[string, Partial<LockNode>, RegExp]>([
    [
      'a package with no resolved and a URL version',
      { resolved: null, version: 'http:127.0.0.1:9/x-1.0.0.tgz' },
      /node_modules\/x has version "http:127\.0\.0\.1:9\/x-1\.0\.0\.tgz", not a semver version/,
    ],
    [
      'a package with no resolved and a host directory version',
      { resolved: null, version: '/srv/secrets' },
      /not a semver version/,
    ],
    [
      'a package with no resolved and a semver version',
      { resolved: null },
      /node_modules\/x has no resolved URL, so npm fetches it from its version/,
    ],
    [
      'a package resolved from a tarball on another origin',
      { resolved: 'http://127.0.0.1:9/x/-/x-1.0.0.tgz' },
      /resolves from http:\/\/127\.0\.0\.1:9\/x\/-\/x-1\.0\.0\.tgz, not a tarball on an allowed registry/,
    ],
    [
      'a registry tarball locked with a URL version',
      { version: 'http:127.0.0.1:9/x-1.0.0.tgz' },
      /not a semver version/,
    ],
    [
      'a bundled package with a URL version',
      { resolved: null, inDepBundle: true, version: 'http:127.0.0.1:9/x-1.0.0.tgz' },
      /not a semver version/,
    ],
    [
      'a bundled package resolved off the registries',
      { inDepBundle: true, resolved: 'file:../x' },
      /resolves from file:\.\.\/x/,
    ],
  ])('refuses %s', (_label, node, detail) => {
    // fails-when: the package passes, so npm ci fetches it from an origin, a
    // directory or a tarball the operator did not allow.
    expect(scan(tree([{}, { location: 'node_modules/x', ...node }]))).toMatch(detail);
  });
});

describe('checkLockedInstall', () => {
  let kici: string;
  beforeEach(async () => {
    kici = await mkdtemp(join(tmpdir(), 'kici-locked-'));
  });
  afterEach(async () => {
    await rm(kici, { recursive: true, force: true });
  });

  const writeLock = (lock: unknown) =>
    writeFile(join(kici, 'package-lock.json'), JSON.stringify(lock));
  const COMPLETE_V3 = { lockfileVersion: 3, packages: { '': {} } };

  it.each<[string, HostInstallTool]>([
    ['pnpm', { ...CI_TOOL, packageManager: PackageManager.Pnpm, version: '11.3.0' }],
    ['npm 11.15.0', { ...CI_TOOL, version: '11.15.0' }],
    ['npm 11.19.1', { ...CI_TOOL, version: '11.19.1' }],
  ])('does not apply to %s, which refuses non-registry sources itself', async (_l, tool) => {
    const loadReader = vi.fn(() => null);
    // breaks-if-wrong: an install that needs no lockfile keeps running on the host.
    expect(await checkLockedInstall(kici, planWith(null), tool, loadReader)).toBeNull();
    expect(loadReader).not.toHaveBeenCalled();
  });

  it('refuses an npm ci install with no lockfile', async () => {
    // fails-when: npm 11.12.1 installs with no lockfile and resolves a URL dependency.
    expect(await checkLockedInstall(kici, planWith(null), CI_TOOL)).toEqual({
      eligible: false,
      refusal: HostInstallRefusal.LockfileRequired,
      detail: `npm ${CI_NPM_VERSION} cannot refuse URL, file or directory dependencies itself, so the host install runs npm ci, which needs a lockfile`,
    });
  });

  it.each<[string, unknown]>([
    ['a version 1 lockfile', { lockfileVersion: 1, dependencies: {} }],
    ['a lockfile with no packages map', { lockfileVersion: 3 }],
    ['a lockfile that does not parse', '{'],
  ])('refuses %s', async (_label, lock) => {
    if (typeof lock === 'string') await writeFile(join(kici, 'package-lock.json'), lock);
    else await writeLock(lock);
    const loadReader = vi.fn(() => readerOf(async () => tree([])));
    // fails-when: npm ci gets a lockfile whose edges it rebuilds from the registry.
    expect(
      await checkLockedInstall(kici, planWith('package-lock.json'), CI_TOOL, loadReader),
    ).toMatchObject({ refusal: HostInstallRefusal.LockfileUnpinned });
    expect(loadReader).not.toHaveBeenCalled();
  });

  it('reads the tree with the npm that runs the install', async () => {
    await writeLock(COMPLETE_V3);
    const load = vi.fn(async () =>
      tree([{ edges: [edge('foo')] }, { location: 'node_modules/foo' }]),
    );
    const loadReader = vi.fn(() => readerOf(load));

    expect(
      await checkLockedInstall(kici, planWith('package-lock.json'), CI_TOOL, loadReader),
    ).toBeNull();
    expect(loadReader).toHaveBeenCalledWith(CI_TOOL.script);
    expect(load).toHaveBeenCalledWith(kici);
  });

  it.each<[string, () => NpmLockReader | null, RegExp]>([
    ['npm ships no lockfile reader', () => null, /ships no lockfile reader/],
    [
      'the reader throws',
      () => readerOf(async () => Promise.reject(new Error('Unexpected token'))),
      /npm could not read \.kici\/package-lock\.json: Unexpected token/,
    ],
    [
      // fails-when: the check runs outside the try, so a tree it cannot walk
      // fails the job instead of leaving the install to the container.
      'the tree has a shape the check does not expect',
      () => readerOf(async () => ({ inventory: new Map([['', { location: '' }]]) }) as never),
      /npm could not read \.kici\/package-lock\.json: /,
    ],
    [
      'the tree leaves an edge open',
      () => readerOf(async () => tree([{ edges: [edge('foo', { to: null })] }])),
      /\.kici\/package-lock\.json: the project depends on foo/,
    ],
    [
      'a package has no resolved URL',
      () =>
        readerOf(async () =>
          tree([
            { edges: [edge('foo', { spec: '*' })] },
            { location: 'node_modules/foo', resolved: null, version: '/srv/secrets' },
          ]),
        ),
      /\.kici\/package-lock\.json: node_modules\/foo has version "\/srv\/secrets"/,
    ],
  ])('refuses when %s', async (_label, loader, detail) => {
    await writeLock(COMPLETE_V3);
    const refused = await checkLockedInstall(kici, planWith('package-lock.json'), CI_TOOL, loader);
    expect(refused).toMatchObject({ refusal: HostInstallRefusal.LockfileUnpinned });
    expect(refused?.detail).toMatch(detail);
  });
});

/** A gzip tarball holding `package/package.json`, and its sha512 integrity. */
async function packTarball(
  work: string,
  manifest: Record<string, unknown>,
): Promise<{ bytes: Buffer; integrity: string }> {
  const src = await mkdtemp(join(work, 'src-'));
  await mkdir(join(src, 'package'));
  await writeFile(join(src, 'package', 'package.json'), JSON.stringify(manifest));
  const file = join(src, 'pkg.tgz');
  await tarCreate({ gzip: true, file, cwd: src, portable: true }, ['package']);
  const bytes = await readFile(file);
  return { bytes, integrity: `sha512-${createHash('sha512').update(bytes).digest('base64')}` };
}

/** Listen on a loopback port, recording each request path. */
async function listen(
  handler: (url: string) => { type: string; body: Buffer | string } | null,
): Promise<{ server: Server; origin: string; hits: string[] }> {
  const hits: string[] = [];
  const server = createServer((req, res) => {
    hits.push(req.url ?? '');
    const found = handler(req.url ?? '');
    if (!found) {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, { 'content-type': found.type }).end(found.body);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return { server, origin: `http://127.0.0.1:${port}`, hits };
}

const npmTool = await resolveHostNpm();

describe.skipIf(!npmTool)('npmLockReader — the npm bundled with this Node', () => {
  it("reads versions with npm's own semver", () => {
    const reader = npmLockReader(npmTool!.script);
    expect(reader).not.toBeNull();
    // breaks-if-wrong: the versions npm writes for registry packages pass.
    expect(['1.2.3', '1.2.3-rc.1+build.5'].map((v) => reader!.isVersion(v))).toEqual([true, true]);
    // fails-when: a URL, a path, a range or a dist-tag reads as a version, so a
    // locked package with no resolved passes with a source npm ci fetches.
    expect(
      ['http:127.0.0.1:9/x.tgz', '/srv/secrets', '', '^1.2.3', 'latest'].map((v) =>
        reader!.isVersion(v),
      ),
    ).toEqual([false, false, false, false, false]);
  });

  it('is null for a path that holds no npm', () => {
    expect(npmLockReader(join(tmpdir(), 'no-npm-here', 'bin', 'npm-cli.js'))).toBeNull();
  });
});

/**
 * The real npm against a loopback registry. `foo` is a registry package that
 * declares its own dependency on a tarball URL on a second server, `outside`,
 * which stands for any origin the operator did not allow. `baz` depends on
 * nothing. The npm runs with the argv the host install gives an npm that runs
 * `npm ci`, whatever the local npm's own version.
 */
describe.skipIf(!npmTool)('npm ci on the agent host — real npm, loopback registry', () => {
  const ciTool: HostInstallTool = { ...npmTool!, version: CI_NPM_VERSION };
  let work: string;
  let registry: Awaited<ReturnType<typeof listen>>;
  let outside: Awaited<ReturnType<typeof listen>>;
  let foo: { bytes: Buffer; integrity: string };
  let baz: { bytes: Buffer; integrity: string };
  let barUrl: string;
  /** A directory on the agent host a lockfile can name as a package version. */
  let hostDir: string;

  const tarballUrl = (name: string) => `${registry.origin}/${name}/-/${name}-1.0.0.tgz`;
  const lockEntry = (name: string, pkg: { integrity: string }) => ({
    version: '1.0.0',
    resolved: tarballUrl(name),
    integrity: pkg.integrity,
  });

  beforeAll(async () => {
    work = await mkdtemp(join(tmpdir(), 'kici-npm-ci-'));
    const bar = await packTarball(work, { name: 'bar', version: '1.0.0' });
    outside = await listen(() => ({ type: 'application/octet-stream', body: bar.bytes }));
    barUrl = `${outside.origin}/bar-1.0.0.tgz`;
    foo = await packTarball(work, { name: 'foo', version: '1.0.0', dependencies: { bar: barUrl } });
    baz = await packTarball(work, { name: 'baz', version: '1.0.0' });
    hostDir = join(work, 'host-dir');
    await mkdir(hostDir);
    await writeFile(
      join(hostDir, 'package.json'),
      JSON.stringify({ name: 'foo', version: '9.9.9' }),
    );
    await writeFile(join(hostDir, 'secret.txt'), 'agent host file');
    const packages: Record<
      string,
      { deps: Record<string, string>; tgz: { bytes: Buffer; integrity: string } }
    > = { foo: { deps: { bar: barUrl }, tgz: foo }, baz: { deps: {}, tgz: baz } };
    registry = await listen((url) => {
      const name = url.slice(1).split('/')[0]!;
      const pkg = packages[name];
      if (!pkg) return null;
      if (url === `/${name}`) {
        const version = {
          name,
          version: '1.0.0',
          dependencies: pkg.deps,
          dist: { tarball: tarballUrl(name), integrity: pkg.tgz.integrity },
        };
        const packument = {
          name,
          'dist-tags': { latest: '1.0.0' },
          versions: { '1.0.0': version },
        };
        return { type: 'application/json', body: JSON.stringify(packument) };
      }
      return url === `/${name}/-/${name}-1.0.0.tgz`
        ? { type: 'application/octet-stream', body: pkg.tgz.bytes }
        : null;
    });
  });

  afterAll(async () => {
    registry?.server.close();
    outside?.server.close();
    await rm(work, { recursive: true, force: true });
  });

  let root: string;
  let kici: string;
  beforeEach(async () => {
    root = await mkdtemp(join(work, 'repo-'));
    kici = join(root, '.kici');
    await mkdir(kici);
    await writeFile(join(kici, '.npmrc'), `registry=${registry.origin}/\n`);
    outside.hits.length = 0;
  });

  async function project(dependencies: Record<string, string>, lock?: unknown): Promise<void> {
    await writeFile(
      join(kici, 'package.json'),
      JSON.stringify({ name: 'k', version: '1.0.0', private: true, dependencies }),
    );
    if (lock !== undefined) {
      await writeFile(
        join(kici, 'package-lock.json'),
        JSON.stringify({
          name: 'k',
          version: '1.0.0',
          lockfileVersion: 3,
          requires: true,
          ...(lock as object),
        }),
      );
    }
  }

  /**
   * Run the real npm in `.kici/` with a scratch cache: `npm ci` with the argv
   * the host install builds for it, or `npm install` with the same flags, which
   * is what an npm without `--allow-remote` ran before it ran `npm ci`.
   */
  async function runNpm(command: NpmInstallCommand): Promise<void> {
    const home = await mkdtemp(join(work, 'home-'));
    const argv = buildHostInstallArgs(ciTool, {
      cache: join(home, 'cache'),
      store: join(home, 'store'),
      userconfig: join(kici, '.npmrc'),
    });
    expect(argv[1]).toBe(NpmInstallCommand.Ci);
    argv[1] = command;
    await execFileAsync(ciTool.nodeExe, argv, {
      cwd: kici,
      env: { PATH: process.env.PATH, HOME: home },
    }).catch(() => {
      // An out-of-sync lockfile fails npm ci; what it fetched first is the point.
    });
  }

  const eligibility = () =>
    checkHostInstallEligibility(root, {
      hostInstallRegistries: [registry.origin],
      operatorNpmrc: null,
    });

  /**
   * The plan the eligibility check hands on for this project, built directly,
   * so the lockfile check is exercised on a lockfile the eligibility check
   * would refuse first.
   */
  const lockedPlan = (): HostInstallPlan => ({
    packageManager: PackageManager.Npm,
    lockfile: 'package-lock.json',
    registries: [new URL(`${registry.origin}/`)],
    npmrc: NPMRC,
  });

  it('positive control: without a lockfile, npm fetches a registry package’s own URL dependency', async () => {
    await project({ foo: '1.0.0' });
    await runNpm(NpmInstallCommand.Install);
    // The vector is live: npm contacted the outside origin from the host.
    expect(outside.hits).toEqual(['/bar-1.0.0.tgz']);

    // The lockfile npm wrote pins bar to that origin, and the eligibility
    // check refuses it: pinned to an allowed origin, or refused.
    const written = JSON.parse(await readFile(join(kici, 'package-lock.json'), 'utf-8'));
    expect(written.packages['node_modules/bar'].resolved).toBe(barUrl);
    await rm(join(kici, 'node_modules'), { recursive: true, force: true });
    // fails-when: the lockfile's resolved origin is not checked against the
    // allowed registries.
    expect(await eligibility()).toMatchObject({
      eligible: false,
      refusal: HostInstallRefusal.NonRegistryDependency,
      detail: expect.stringContaining(`node_modules/bar resolved from ${barUrl}`),
    });
  }, 120_000);

  it.each<[string, () => unknown, RegExp]>([
    [
      'a lockfile that omits a package the project needs',
      () => ({ packages: { '': { name: 'k', dependencies: { foo: '1.0.0' } } } }),
      /the project depends on foo@1\.0\.0, which the lockfile does not pin/,
    ],
    [
      'a lockfile that records the URL dependency with no package for it',
      () => ({
        packages: {
          '': { name: 'k', dependencies: { foo: '1.0.0' } },
          'node_modules/foo': { ...lockEntry('foo', foo), dependencies: { bar: barUrl } },
        },
      }),
      /node_modules\/foo depends on bar@http:\/\/127\.0\.0\.1:\d+\/bar-1\.0\.0\.tgz, which the lockfile does not pin/,
    ],
  ])(
    'refuses %s, which npm ci would fetch from the outside origin',
    async (_label, lock, detail) => {
      await project({ foo: '1.0.0' }, lock());
      const plan = await eligibility();
      // The allowlist alone admits it: every resolved URL is on the registry.
      expect(plan).toMatchObject({ eligible: true });
      if (!plan.eligible) return;

      const refused = await checkLockedInstall(kici, plan.plan, ciTool);
      // fails-when: the check misses the open edge, so the host install runs
      // npm ci, which fetches bar from the outside origin (the control below).
      expect(refused).toMatchObject({ refusal: HostInstallRefusal.LockfileUnpinned });
      expect(refused?.detail).toMatch(detail);

      // Positive control: npm ci on this lockfile does contact the outside
      // origin before it refuses the out-of-sync lockfile.
      await runNpm(NpmInstallCommand.Ci);
      expect(outside.hits).toEqual(['/bar-1.0.0.tgz']);
    },
    120_000,
  );

  it.each<[string, () => { deps: Record<string, string>; lock: unknown; installed: string }]>([
    [
      'a registry-only project',
      () => ({
        deps: { baz: '^1.0.0' },
        lock: {
          packages: {
            '': { name: 'k', dependencies: { baz: '^1.0.0' } },
            'node_modules/baz': lockEntry('baz', baz),
          },
        },
        installed: 'baz',
      }),
    ],
    [
      'a lockfile that pins foo without its URL dependency',
      () => ({
        deps: { foo: '1.0.0' },
        lock: {
          packages: {
            '': { name: 'k', dependencies: { foo: '1.0.0' } },
            'node_modules/foo': lockEntry('foo', foo),
          },
        },
        installed: 'foo',
      }),
    ],
  ])(
    'installs %s on the host with npm ci, fetching only what the lockfile pins',
    async (_label, shape) => {
      const { deps, lock, installed } = shape();
      await project(deps, lock);
      const plan = await eligibility();
      expect(plan).toMatchObject({ eligible: true });
      if (!plan.eligible) return;
      // breaks-if-wrong: a lockfile that pins every package passes the check
      // and installs on the host.
      expect(await checkLockedInstall(kici, plan.plan, ciTool)).toBeNull();

      await runHostIsolatedInstall({
        kiciDir: kici,
        plan: plan.plan,
        tool: ciTool,
        registries: [],
        installEnvSecrets: {},
        jobIdShort: 'job12345',
        baseEnv: { PATH: process.env.PATH },
      });

      expect(existsSync(join(kici, 'node_modules', installed, 'package.json'))).toBe(true);
      expect(registry.hits).toContain(`/${installed}/-/${installed}-1.0.0.tgz`);
      // fails-when: the install re-resolves foo's own dependencies, which the
      // positive control above shows reaches the outside origin.
      expect(outside.hits).toEqual([]);
      expect(existsSync(join(kici, 'node_modules', 'bar'))).toBe(false);
    },
    120_000,
  );

  it.each<[string, () => string, () => void]>([
    [
      'a URL with no slashes',
      () => barUrl.replace('http://', 'http:'),
      () => expect(outside.hits).toEqual(['/bar-1.0.0.tgz']),
    ],
    [
      'a directory on the agent host',
      () => hostDir,
      () => expect(existsSync(join(kici, 'node_modules', 'foo', 'secret.txt'))).toBe(true),
    ],
  ])(
    'refuses a locked package with no resolved whose version is %s, which npm ci would fetch',
    async (_label, version, fetched) => {
      await project(
        { foo: '*' },
        {
          packages: {
            '': { name: 'k', dependencies: { foo: '*' } },
            'node_modules/foo': { version: version() },
          },
        },
      );
      // fails-when: the lockfile scan reads the version as a registry version.
      expect(await eligibility()).toMatchObject({
        eligible: false,
        refusal: HostInstallRefusal.NonRegistryDependency,
        detail: expect.stringContaining('node_modules/foo version'),
      });

      // The edge check alone passes it: npm reads the "*" edge as satisfied by
      // whatever the lockfile locks.
      const reader = npmLockReader(ciTool.script)!;
      expect(findUnpinnedDependency(await reader.loadTree(kici))).toBeNull();

      // The lockfile check refuses it on its own, reading it with the real npm.
      const refused = await checkLockedInstall(kici, lockedPlan(), ciTool);
      // fails-when: a package with no resolved passes because its "*" edge is
      // valid, so the host install runs npm ci on this lockfile.
      expect(refused).toMatchObject({ refusal: HostInstallRefusal.LockfileUnpinned });
      expect(refused?.detail).toMatch(/node_modules\/foo has version .*, not a semver version/);

      // Positive control: npm ci on this lockfile fetches the URL, or copies
      // the directory, from the agent host.
      await runNpm(NpmInstallCommand.Ci);
      fetched();
    },
    120_000,
  );

  /** A lockfile that bundles `qux` in `baz`, locking qux at `version` with no resolved. */
  const bundledLock = (version: string) => ({
    packages: {
      '': { name: 'k', dependencies: { baz: '^1.0.0' } },
      'node_modules/baz': {
        ...lockEntry('baz', baz),
        bundleDependencies: ['qux'],
        dependencies: { qux: '*' },
      },
      'node_modules/baz/node_modules/qux': { version, inBundle: true },
    },
  });

  it('passes a package bundled in its parent, which has no resolved of its own', async () => {
    await project({ baz: '^1.0.0' }, bundledLock('1.0.0'));
    // breaks-if-wrong: the real reader marks qux as bundled, so its missing
    // resolved does not refuse the lockfile.
    expect(await checkLockedInstall(kici, lockedPlan(), ciTool)).toBeNull();
  });

  it('refuses a bundled package whose version is not a semver version', async () => {
    await project({ baz: '^1.0.0' }, bundledLock(barUrl.replace('http://', 'http:')));
    // fails-when: a bundled package passes with any version, which leaves its
    // safety to how each npm version unpacks a bundle.
    expect((await checkLockedInstall(kici, lockedPlan(), ciTool))?.detail).toMatch(
      /node_modules\/baz\/node_modules\/qux has version/,
    );
  });
});

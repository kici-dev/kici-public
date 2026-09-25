import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PackageManager } from '@kici-dev/shared/package-manager';
import {
  HostInstallRefusal,
  checkHostInstallEligibility,
  findNonRegistryNpmLockEntry,
  findNonRegistryOverride,
  findNonRegistryPnpmLockEntry,
  isRegistrySpec,
  type HostInstallEligibilityOptions,
} from './host-install-eligibility.js';
import { allowedRegistries, loadNpmIni } from './npmrc-allowlist.js';

/** The public npm registry plus one private registry the config names. */
const REGISTRIES = allowedRegistries([{ '@s:registry': 'http://verdaccio.local:4873/' }], []);
/** The registries a plan carries when the operator configured none: npm's public one. */
const PUBLIC_REGISTRY = [new URL('https://registry.npmjs.org/')];

describe('isRegistrySpec', () => {
  it.each([
    '1.2.3',
    '^1.2.3',
    '~1.2',
    '>=1.0.0 <2',
    '1.x || 2.x',
    '1.0.0 - 2.0.0',
    '*',
    '',
    'latest',
    'next',
    '0.10.0-9896',
    'npm:@kici-dev/sdk@^1.0.0',
    'npm:left-pad',
  ])('accepts the registry spec %j', (spec) => {
    // breaks-if-wrong: an ordinary version, range, tag or npm alias must pass.
    expect(isRegistrySpec(spec)).toBe(true);
  });

  it.each([
    'git+https://github.com/a/b.git',
    'git+ssh://git@github.com/a/b.git',
    'github:a/b',
    'a/b',
    'a/b#main',
    'https://example.com/pkg.tgz',
    'file:../lib',
    'link:../lib',
    'workspace:*',
    'portal:../lib',
    'patch:foo@1.0.0#./p.patch',
    'runtime:22',
    './lib',
    '../lib',
    '~/lib',
    '/abs/lib',
    'pkg.tgz',
    'npm:@scope/name@git+https://x/y.git',
  ])('refuses the non-registry spec %j', (spec) => {
    // fails-when: a git / file / URL / protocol specifier passes as a registry one.
    expect(isRegistrySpec(spec)).toBe(false);
  });
});

describe('lockfile scanners', () => {
  it('npm: accepts registry tarballs and refuses links, git and non-registry URLs', () => {
    const registry = {
      'node_modules/a': {
        resolved: 'https://registry.npmjs.org/a/-/a-1.0.0.tgz',
        version: '1.0.0',
      },
      'node_modules/@s/b': { resolved: 'http://verdaccio.local:4873/@s/b/-/b-2.0.0.tgz' },
    };
    const scan = (lock: Record<string, unknown>) => findNonRegistryNpmLockEntry(lock, REGISTRIES);
    // breaks-if-wrong: tarballs on the public and a configured registry pass.
    expect(scan({ packages: { '': {}, ...registry } })).toBeNull();
    expect(scan({ packages: { 'node_modules/x': { link: true } } })).toMatch(/link/);
    expect(
      scan({
        packages: { 'node_modules/x': { resolved: 'git+ssh://git@github.com/a/b.git#abc' } },
      }),
    ).toMatch(/git\+ssh/);
    expect(
      scan({ packages: { 'node_modules/x': { resolved: 'https://example.com/x/-/x-1.0.0.tgz' } } }),
    ).toMatch(/example\.com/);
    // fails-when: a registry-shaped tarball URL on the agent's loopback passes,
    // so the host npm fetches it.
    expect(
      scan({
        packages: { 'node_modules/x': { resolved: 'http://127.0.0.1:9000/x/-/x-1.0.0.tgz' } },
      }),
    ).toMatch(/127\.0\.0\.1/);
    // lockfileVersion 1 keeps nested dependencies.
    expect(
      scan({ dependencies: { a: { dependencies: { b: { version: 'github:a/b#abc' } } } } }),
    ).toMatch(/a > b/);
    expect(
      scan({
        dependencies: {
          a: { resolved: 'http://localhost:8080/a/-/a-1.0.0.tgz', version: '1.0.0' },
        },
      }),
    ).toMatch(/localhost/);
  });

  it.each([
    ['a URL with no slashes', 'http:127.0.0.1:9000/x-1.0.0.tgz'],
    ['a host directory', '/srv/secrets'],
    ['a relative tarball path', '../x-1.0.0.tgz'],
    ['a home-relative path', '~/x'],
    ['a non-string value', 1],
  ])('npm: refuses a locked version that is %s', (_label, version) => {
    // fails-when: the version passes; npm fetches a package with no `resolved`
    // from what its version names, from the agent host.
    expect(
      findNonRegistryNpmLockEntry({ packages: { 'node_modules/x': { version } } }, REGISTRIES),
    ).toMatch(/node_modules\/x version/);
    expect(findNonRegistryNpmLockEntry({ dependencies: { x: { version } } }, REGISTRIES)).toMatch(
      /x version/,
    );
  });

  it('npm: accepts semver versions and a lockfileVersion 1 npm: alias', () => {
    // breaks-if-wrong: the versions npm writes for registry packages stay eligible.
    expect(
      findNonRegistryNpmLockEntry(
        {
          packages: {
            '': { version: '1.0.0' },
            'node_modules/a': { version: '1.2.3-rc.1+build.5' },
            'node_modules/b': {},
          },
          dependencies: { a: { version: '1.2.3' }, c: { version: 'npm:real-c@2.0.0' } },
        },
        REGISTRIES,
      ),
    ).toBeNull();
  });

  it('pnpm: accepts integrity and registry tarballs, refuses other tarballs, git, directory and links', () => {
    const scan = (lock: Record<string, unknown>) => findNonRegistryPnpmLockEntry(lock, REGISTRIES);
    const ok = {
      importers: { '.': { dependencies: { a: { specifier: '^1', version: '1.0.0' } } } },
      packages: {
        'a@1.0.0': { resolution: { integrity: 'sha512-x' } },
        '@s/b@2.0.0': {
          resolution: {
            integrity: 'sha512-y',
            tarball: 'http://verdaccio.local:4873/@s/b/-/b-2.0.0.tgz',
          },
        },
      },
    };
    // breaks-if-wrong: integrity-only and configured-registry tarballs pass.
    expect(scan(ok)).toBeNull();
    for (const resolution of [
      { integrity: 'sha512-x', tarball: 'http://127.0.0.1:9000/a/-/a-1.0.0.tgz' },
      { integrity: 'sha512-x', tarball: 'https://example.com/a/-/a-1.0.0.tgz' },
      { tarball: 'https://registry.npmjs.org/a/-/a-1.0.0.tgz' },
      { type: 'git', repo: 'https://x', commit: 'abc' },
      { directory: '../a', type: 'directory' },
    ]) {
      // fails-when: a tarball off the configured registries, or a resolution
      // with no integrity, passes.
      expect(scan({ packages: { a: { resolution } } })).not.toBeNull();
    }
    expect(
      scan({
        importers: {
          '.': { dependencies: { a: { specifier: 'link:../a', version: 'link:../a' } } },
        },
      }),
    ).toMatch(/link:/);
    expect(scan({ pnpmfileChecksum: 'abc' })).toMatch(/pnpmfile/);
  });
});

describe('findNonRegistryOverride', () => {
  it('accepts registry specs, nested maps and $name references', () => {
    // breaks-if-wrong: ordinary overrides stay eligible.
    expect(
      findNonRegistryOverride({ a: '1.2.3', b: { '.': '^2', c: '$c' }, d: '-' }, 'overrides'),
    ).toBeNull();
  });

  it.each([
    [{ a: 'git+https://x/y.git' }, /overrides\.a/],
    [{ a: { b: 'file:../b' } }, /overrides\.a\.b/],
    [{ a: 'https://example.com/a.tgz' }, /overrides\.a/],
    [{ a: 'link:../a' }, /overrides\.a/],
    [['a'], /not an override map/],
  ])('refuses %j', (overrides, detail) => {
    // fails-when: an override swaps a registry dependency for a git, file or
    // URL source the dependency fields alone would have refused.
    expect(findNonRegistryOverride(overrides, 'overrides')).toMatch(detail);
  });
});

describe('checkHostInstallEligibility', () => {
  let repo: string;
  let kici: string;

  beforeEach(async () => {
    repo = await mkdtemp(join(tmpdir(), 'kici-eligibility-'));
    kici = join(repo, '.kici');
    await mkdir(kici);
    await writeFile(
      join(kici, 'package.json'),
      JSON.stringify({ name: 'wf', private: true, devDependencies: { '@kici-dev/sdk': '^1.0.0' } }),
    );
  });

  afterEach(async () => {
    await rm(repo, { recursive: true, force: true });
  });

  const write = (rel: string, content: string) => writeFile(join(repo, rel), content);
  // The agent user's own ~/.npmrc is not an input of these cases.
  const check = (dir: string, opts: HostInstallEligibilityOptions = {}) =>
    checkHostInstallEligibility(dir, { operatorNpmrc: null, ...opts });
  const npmrcPlan = (repoEntries: Record<string, unknown> = {}, operator = {}) => ({
    ini: expect.objectContaining({ decode: expect.any(Function) }),
    operator,
    repo: repoEntries,
  });

  it('accepts a plain npm project, with and without a registry lockfile', async () => {
    // breaks-if-wrong: the default `kici init` layout must stay eligible.
    expect(await check(repo)).toEqual({
      eligible: true,
      plan: {
        packageManager: PackageManager.Npm,
        lockfile: null,
        registries: PUBLIC_REGISTRY,
        npmrc: npmrcPlan(),
      },
    });
    await write(
      '.kici/package-lock.json',
      JSON.stringify({
        lockfileVersion: 3,
        packages: {
          '': {},
          'node_modules/@kici-dev/sdk': {
            resolved: 'https://registry.npmjs.org/@kici-dev/sdk/-/sdk-1.0.0.tgz',
          },
        },
      }),
    );
    expect(await check(repo)).toEqual({
      eligible: true,
      plan: {
        packageManager: PackageManager.Npm,
        lockfile: 'package-lock.json',
        registries: PUBLIC_REGISTRY,
        npmrc: npmrcPlan(),
      },
    });
  });

  it('accepts a standalone pnpm project and its registry lockfile', async () => {
    await write('.kici/pnpm-lock.yaml', "lockfileVersion: '9.0'\nimporters:\n  .: {}\n");
    expect(await check(repo)).toEqual({
      eligible: true,
      plan: {
        packageManager: PackageManager.Pnpm,
        lockfile: 'pnpm-lock.yaml',
        registries: PUBLIC_REGISTRY,
        npmrc: npmrcPlan(),
      },
    });
  });

  it("hands the install the operator's registries, never the repository's", async () => {
    await write('.kici/.npmrc', '@s:registry=https://npm.acme.internal/private/\n');
    const result = await check(repo, {
      hostInstallRegistries: ['https://npm.acme.internal'],
      operatorNpmrc: 'registry=http://verdaccio.local:4873/\n',
    });
    // fails-when: the plan carries no registries, or the repository's, so the
    // lockfile check reads tarball origins against a set the operator did not choose.
    expect(result.eligible && result.plan.registries.map((u) => u.href)).toEqual([
      'https://registry.npmjs.org/',
      'https://npm.acme.internal/',
      'http://verdaccio.local:4873/',
    ]);
  });

  // Each case flips one input of the eligible npm project above. fails-when: the
  // named vector is not detected, so the host install runs repository code.
  it.each<[string, () => Promise<unknown>, HostInstallRefusal]>([
    [
      'a yarn packageManager field',
      () => write('package.json', JSON.stringify({ packageManager: 'yarn@4.1.0' })),
      HostInstallRefusal.YarnProject,
    ],
    ['a yarn.lock', () => write('.kici/yarn.lock', ''), HostInstallRefusal.YarnProject],
    [
      'a .yarnrc.yml at the root',
      () => write('.yarnrc.yml', 'yarnPath: ./x.cjs\n'),
      HostInstallRefusal.YarnProject,
    ],
    [
      'a .pnpmfile.cjs in .kici',
      () => write('.kici/.pnpmfile.cjs', ''),
      HostInstallRefusal.PnpmHooks,
    ],
    ['a .pnpmfile.mjs at the root', () => write('.pnpmfile.mjs', ''), HostInstallRefusal.PnpmHooks],
    [
      'a pnpmfile setting',
      () => write('.kici/.npmrc', 'pnpmfile=./hooks.cjs\n'),
      HostInstallRefusal.PnpmHooks,
    ],
    [
      'a config-dependencies setting at the root',
      () => write('.npmrc', 'config-dependencies=x\n'),
      HostInstallRefusal.PnpmHooks,
    ],
    [
      'a pnpm-workspace.yaml (settings, configDependencies)',
      () => write('pnpm-workspace.yaml', 'configDependencies:\n  x: 1.0.0\n'),
      HostInstallRefusal.WorkspaceLayout,
    ],
    [
      'root workspaces',
      () => write('package.json', JSON.stringify({ workspaces: ['packages/*'] })),
      HostInstallRefusal.WorkspaceLayout,
    ],
    [
      'a package.json#pnpm hooks key',
      () =>
        write(
          '.kici/package.json',
          JSON.stringify({ name: 'wf', pnpm: { configDependencies: { x: '1.0.0' } } }),
        ),
      HostInstallRefusal.PnpmManifestSettings,
    ],
    [
      'a git dependency',
      () =>
        write('.kici/package.json', JSON.stringify({ dependencies: { x: 'git+https://x/y.git' } })),
      HostInstallRefusal.NonRegistryDependency,
    ],
    [
      'a file dependency',
      () => write('.kici/package.json', JSON.stringify({ dependencies: { x: 'file:../x' } })),
      HostInstallRefusal.NonRegistryDependency,
    ],
    [
      'a tarball URL dependency',
      () => write('.kici/package.json', JSON.stringify({ dependencies: { x: 'https://x/y.tgz' } })),
      HostInstallRefusal.NonRegistryDependency,
    ],
    [
      'a transitive git entry in the lockfile',
      () =>
        write(
          '.kici/package-lock.json',
          JSON.stringify({
            lockfileVersion: 3,
            packages: { 'node_modules/x': { resolved: 'git+ssh://git@github.com/a/b.git#abc' } },
          }),
        ),
      HostInstallRefusal.NonRegistryDependency,
    ],
    [
      'an unparsable lockfile',
      () => write('.kici/package-lock.json', '{not json'),
      HostInstallRefusal.UnreadableManifest,
    ],
    [
      'a lone CR hiding a second key in .kici/.npmrc',
      () =>
        write(
          '.kici/.npmrc',
          'registry=https://registry.npmjs.org/\rhttps-proxy=http://a.example/\n',
        ),
      HostInstallRefusal.UnsafeNpmrc,
    ],
    [
      'a lone CR hiding a pnpmfile key in the root .npmrc',
      () => write('.npmrc', 'registry=https://registry.npmjs.org/\rpnpmfile=./hooks.cjs\n'),
      HostInstallRefusal.UnsafeNpmrc,
    ],
    [
      'a git override',
      () =>
        write(
          '.kici/package.json',
          JSON.stringify({ name: 'wf', overrides: { x: { y: 'git+https://x/y.git' } } }),
        ),
      HostInstallRefusal.NonRegistryDependency,
    ],
    [
      'a pnpm.overrides link',
      () =>
        write('.kici/package.json', JSON.stringify({ pnpm: { overrides: { x: 'link:../x' } } })),
      HostInstallRefusal.NonRegistryDependency,
    ],
    [
      'a file resolution',
      () => write('.kici/package.json', JSON.stringify({ resolutions: { x: 'file:../x' } })),
      HostInstallRefusal.NonRegistryDependency,
    ],
    [
      'a lockfile tarball on the agent loopback',
      () =>
        write(
          '.kici/package-lock.json',
          JSON.stringify({
            lockfileVersion: 3,
            packages: { 'node_modules/x': { resolved: 'http://127.0.0.1:9000/x/-/x-1.0.0.tgz' } },
          }),
        ),
      HostInstallRefusal.NonRegistryDependency,
    ],
    [
      'a pnpm lockfile tarball on the agent loopback',
      () =>
        write(
          '.kici/pnpm-lock.yaml',
          [
            "lockfileVersion: '9.0'",
            'packages:',
            '  x@1.0.0:',
            '    resolution: {integrity: sha512-x, tarball: http://127.0.0.1:9000/x/-/x-1.0.0.tgz}',
            '',
          ].join('\n'),
        ),
      HostInstallRefusal.NonRegistryDependency,
    ],
  ])('refuses %s', async (_name, arrange, refusal) => {
    await arrange();
    const result = await check(repo);
    expect(result).toMatchObject({ eligible: false, refusal });
  });

  it("reads .npmrc keys with npm's parser: a lone CR hides a key from a LF-only reader", async () => {
    const payload = 'registry=https://registry.npmjs.org/\rpnpmfile=./hooks.cjs\n';
    // Positive control: a LF-only key reader sees one key, npm's parser two.
    const lfOnlyKeys = payload
      .split(/\r?\n/)
      .filter(Boolean)
      .map((l) => l.split('=')[0]);
    expect(lfOnlyKeys).toEqual(['registry']);
    expect(Object.keys(loadNpmIni()!.decode(payload))).toEqual(['registry', 'pnpmfile']);

    await write('.kici/.npmrc', payload);
    // fails-when: the check reads keys line by line on LF, so the pnpmfile
    // setting passes as part of a registry line.
    expect(await check(repo)).toMatchObject({
      eligible: false,
      refusal: HostInstallRefusal.UnsafeNpmrc,
    });
  });

  /** The origin an operator lists in KICI_HOST_INSTALL_REGISTRIES. */
  const VERDACCIO = 'http://verdaccio.local:4873';
  const workflowRegistry = (url: string) => [{ url, alwaysAuth: false, token: 't' }];
  const lock = (url: string) =>
    write(
      '.kici/package-lock.json',
      JSON.stringify({ lockfileVersion: 3, packages: { 'node_modules/x': { resolved: url } } }),
    );

  it.each([
    ['on the agent loopback', 'http://127.0.0.1:4873/'],
    ['on localhost', 'http://localhost:4873/'],
    ['on a .local name', 'http://verdaccio.local:4873/'],
    ['on the LAN', 'http://192.168.1.50:4873/'],
    ['on the cloud metadata address', 'http://169.254.169.254/'],
  ])('leaves the install to the container for a workflow registry %s', async (_name, url) => {
    // fails-when: a workflow `registries:` entry widens the allowed origins, so
    // the host npm contacts, and sends a token to, an origin the repository
    // chose from outside the job network's egress filter.
    const result = await check(repo, { workflowRegistries: workflowRegistry(url) });
    expect(result).toMatchObject({
      eligible: false,
      refusal: HostInstallRefusal.UnmanagedRegistry,
    });
    // The step -1 line names the setting that would admit the registry.
    expect(!result.eligible && result.detail).toContain('KICI_HOST_INSTALL_REGISTRIES');
  });

  it('keeps the host install for a workflow registry on an operator-listed or public origin', async () => {
    // breaks-if-wrong: the same Verdaccio registry qualifies once the operator
    // lists its origin, and a scope mapped to npm's public registry needs no
    // listing at all.
    expect(
      await check(repo, {
        workflowRegistries: workflowRegistry('http://verdaccio.local:4873/'),
        hostInstallRegistries: [VERDACCIO],
      }),
    ).toMatchObject({ eligible: true });
    expect(
      await check(repo, { workflowRegistries: workflowRegistry('https://registry.npmjs.org/') }),
    ).toMatchObject({ eligible: true });
  });

  it('accepts a lockfile tarball only on an allowed origin', async () => {
    await lock('http://verdaccio.local:4873/x/-/x-1.0.0.tgz');
    expect(await check(repo)).toMatchObject({
      eligible: false,
      refusal: HostInstallRefusal.NonRegistryDependency,
    });
    // fails-when: a workflow registry on the tarball's origin admits it, so a
    // repository picks the origins its lockfile fetches from.
    expect(
      await check(repo, { workflowRegistries: workflowRegistry('http://verdaccio.local:4873/') }),
    ).toMatchObject({ eligible: false });
    // breaks-if-wrong: the same tarball passes once the operator lists its
    // origin, or the operator's own config names its registry.
    expect(await check(repo, { hostInstallRegistries: [VERDACCIO] })).toMatchObject({
      eligible: true,
    });
    expect(
      await check(repo, { operatorNpmrc: '@s:registry=http://verdaccio.local:4873/\n' }),
    ).toMatchObject({ eligible: true });
  });

  it.each([
    ['registry on the agent loopback', 'registry=http://127.0.0.1:4873/\n'],
    ['a scoped registry on the LAN', '@x:registry=http://192.168.1.50:4873/\n'],
    ['a registry on a port the operator did not list', 'registry=http://verdaccio.local:4874/\n'],
    ['a registry that is not an http(s) URL', 'registry=file:///etc/\n'],
    ['a registry that is not a string', 'registry=true\n'],
  ])('refuses a .kici/.npmrc that sets %s', async (_name, npmrc) => {
    await write('.kici/.npmrc', npmrc);
    // fails-when: a repository-set registry reaches the install, so the host
    // npm contacts any origin the repository chose.
    expect(await check(repo, { hostInstallRegistries: [VERDACCIO] })).toMatchObject({
      eligible: false,
      refusal: HostInstallRefusal.UnmanagedRegistry,
    });
  });

  it('accepts a .kici/.npmrc registry on an allowed origin or the public one', async () => {
    await write(
      '.kici/.npmrc',
      'registry=http://verdaccio.local:4873/\n@s:registry=https://registry.npmjs.org/\n',
    );
    // fails-when: the repository's own registry admits itself.
    expect(await check(repo)).toMatchObject({
      eligible: false,
      refusal: HostInstallRefusal.UnmanagedRegistry,
    });
    // breaks-if-wrong: a repository naming its org's registry, or npm's own,
    // keeps the host install once the operator allows that origin.
    expect(await check(repo, { hostInstallRegistries: [VERDACCIO] })).toMatchObject({
      eligible: true,
    });
    expect(
      await check(repo, { operatorNpmrc: 'registry=http://verdaccio.local:4873/\n' }),
    ).toMatchObject({ eligible: true });
  });

  it('checks lockfile tarballs against the operator registries, not the repository ones', async () => {
    const operatorNpmrc = 'registry=https://npm.acme.internal/npm/\n';
    // Same origin as the operator's registry, so the registry itself passes.
    await write('.kici/.npmrc', '@s:registry=https://npm.acme.internal/private/\n');
    expect(await check(repo, { operatorNpmrc })).toMatchObject({ eligible: true });
    // fails-when: the repository's own registry value widens the tarball set.
    await lock('https://npm.acme.internal/private/x/-/x-1.0.0.tgz');
    expect(await check(repo, { operatorNpmrc })).toMatchObject({
      eligible: false,
      refusal: HostInstallRefusal.NonRegistryDependency,
    });
  });

  it('keeps TLS and proxy keys from the operator config only', async () => {
    await write(
      '.kici/.npmrc',
      [
        '@acme:registry=https://npm.acme.internal/',
        '//npm.acme.internal/:_authToken=${ACME_TOKEN}',
        'strict-ssl=false',
        'ca=-----BEGIN CERTIFICATE-----',
        'cafile=/etc/shadow',
        'https-proxy=http://attacker.example:8080/',
        'node-options=--require ./evil.cjs',
        '',
      ].join('\n'),
    );
    const result = await check(repo, {
      hostInstallRegistries: ['https://npm.acme.internal'],
      operatorNpmrc: 'strict-ssl=false\ncafile=/etc/ssl/corp.pem\nproxy=http://proxy.corp:3128\n',
    });
    // fails-when: the repository turns off TLS verification, trusts its own CA
    // or routes the install through its own proxy.
    expect(result).toMatchObject({
      eligible: true,
      plan: {
        npmrc: npmrcPlan(
          {
            '@acme:registry': 'https://npm.acme.internal/',
            '//npm.acme.internal/:_authToken': '${ACME_TOKEN}',
          },
          { 'strict-ssl': false, cafile: '/etc/ssl/corp.pem', proxy: 'http://proxy.corp:3128' },
        ),
      },
    });
  });

  it.each([
    ['HTTPS_PROXY', '//r.example/:_authToken=${HTTPS_PROXY}\n'],
    ['a lower-case no_proxy', '//r.example/:_authToken=${no_proxy}\n'],
    ['NODE_EXTRA_CA_CERTS', '//r.example/:_auth=${NODE_EXTRA_CA_CERTS}\n'],
    ['NODE_TLS_REJECT_UNAUTHORIZED', '//r.example/:username=${NODE_TLS_REJECT_UNAUTHORIZED}\n'],
    ['SSL_CERT_FILE', '//r.example/:_password=${SSL_CERT_FILE}\n'],
    ['NODE_OPTIONS in npm optional form', '//r.example/:_authToken=${NODE_OPTIONS?}\n'],
    ['HTTP_PROXY in pnpm default form', '//r.example/:_authToken=${HTTP_PROXY:-x}\n'],
  ])('leaves the install to the container when an auth value references %s', async (_n, npmrc) => {
    await write('.kici/.npmrc', npmrc);
    // fails-when: the reference passes, so an install secret under that name
    // reaches the install env and reroutes, re-trusts or preloads npm.
    expect(await check(repo)).toMatchObject({
      eligible: false,
      refusal: HostInstallRefusal.ToolEnvReference,
    });
  });

  it("checks the operator's own auth values too, and keeps a plain secret name", async () => {
    expect(
      await check(repo, { operatorNpmrc: '//r.example/:_authToken=${NODE_OPTIONS}\n' }),
    ).toMatchObject({ eligible: false, refusal: HostInstallRefusal.ToolEnvReference });
    // breaks-if-wrong: the documented `${MY_NPM_TOKEN}` pattern keeps the host
    // install, and a tool-read name outside an auth value is never passed, so
    // it does not refuse.
    await write(
      '.kici/.npmrc',
      '//r.example/:_authToken=${MY_NPM_TOKEN}\nregistry=https://registry.npmjs.org/${HOME}/\n',
    );
    expect(await check(repo)).toMatchObject({ eligible: true });
  });

  it.each([
    ['${NPM_TOKEN}', '//r.example/:_authToken=${NPM_TOKEN}\n'],
    ["npm's optional ${NPM_TOKEN?}", '//r.example/:_authToken=${NPM_TOKEN?}\n'],
    ['${NODE_AUTH_TOKEN}', '//r.example/:_authToken=${NODE_AUTH_TOKEN}\n'],
    ["pnpm's defaulted ${NODE_AUTH_TOKEN:-x}", '//r.example/:_authToken=${NODE_AUTH_TOKEN:-x}\n'],
  ])('keeps the host install when a repository auth value references %s', async (_n, npmrc) => {
    await write('.kici/.npmrc', npmrc);
    // fails-when: the NPM_ / NODE_ prefix refuses the conventional token names, or
    // the whole reference text (`NPM_TOKEN?`, `NODE_AUTH_TOKEN:-x`) is tested as a name.
    expect(await check(repo)).toMatchObject({ eligible: true });
  });

  it("keeps the host install when the operator's ~/.npmrc authenticates with ${NPM_TOKEN}", async () => {
    // fails-when: the operator's conventional npmjs.org token line moves every
    // host install on the agent into the container.
    expect(
      await check(repo, {
        operatorNpmrc: '//registry.npmjs.org/:_authToken=${NPM_TOKEN}\n',
      }),
    ).toMatchObject({ eligible: true });
    // breaks-if-wrong: a longer name in the same namespace still refuses.
    expect(
      await check(repo, {
        operatorNpmrc: '//registry.npmjs.org/:_authToken=${NPM_CONFIG_USERCONFIG}\n',
      }),
    ).toMatchObject({ eligible: false, refusal: HostInstallRefusal.ToolEnvReference });
  });

  it('refuses a workflow registry whose URL or scope could start a new .npmrc line', async () => {
    for (const reg of [
      { url: 'https://r.example/\nnode-options=--x', alwaysAuth: false, token: 't' },
      { url: 'https://r.example/', scope: '@a\rgit', alwaysAuth: false, token: 't' },
    ]) {
      // fails-when: the agent block writes the value raw, so a newline in it
      // adds a key to the install's config.
      expect(await check(repo, { workflowRegistries: [reg] })).toMatchObject({
        eligible: false,
        refusal: HostInstallRefusal.UnsafeNpmrc,
      });
    }
  });

  it("falls back when npm's parser is unavailable", async () => {
    expect(await check(repo, { ini: null })).toMatchObject({
      eligible: false,
      refusal: HostInstallRefusal.NpmrcParserUnavailable,
    });
  });

  it('refuses a symlinked .kici, manifest or .npmrc', async () => {
    const outside = await mkdtemp(join(tmpdir(), 'kici-eligibility-out-'));
    try {
      await writeFile(join(outside, '.npmrc'), 'registry=https://r.example/\n');
      await symlink(join(outside, '.npmrc'), join(kici, '.npmrc'));
      // fails-when: a symlinked config is followed, so the install reads a file
      // outside the checkout the repository chose.
      expect(await check(repo)).toMatchObject({
        eligible: false,
        refusal: HostInstallRefusal.Symlink,
      });

      const repo2 = await mkdtemp(join(tmpdir(), 'kici-eligibility-2-'));
      try {
        await symlink(kici, join(repo2, '.kici'));
        expect(await check(repo2)).toMatchObject({
          eligible: false,
          refusal: HostInstallRefusal.Symlink,
        });
      } finally {
        await rm(repo2, { recursive: true, force: true });
      }
      await rm(join(kici, '.npmrc'));
      await symlink(join(outside, '.npmrc'), join(repo, '.npmrc'));
      expect(await check(repo)).toMatchObject({
        eligible: false,
        refusal: HostInstallRefusal.Symlink,
      });
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });
});

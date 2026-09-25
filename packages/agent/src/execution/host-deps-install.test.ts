import { describe, it, expect, vi } from 'vitest';
import { PackageManager } from '@kici-dev/shared/package-manager';
import {
  HostDepsInstall,
  decideHostDepsInstall,
  hostInstallSecrets,
  installKiciDepsOnHost,
  type HostDepsInstallFacts,
  type InstallKiciDepsOnHostArgs,
} from './host-deps-install.js';
import { HostInstallRefusal } from './host-install-eligibility.js';
import type { HostInstallTool } from './host-isolated-install.js';

/** Facts under which the host installs; each test flips one of them. */
const INSTALLABLE: HostDepsInstallFacts = {
  hasDepsUrl: false,
  hasKiciPackage: true,
  hasNodeModules: false,
  allowInstallScripts: false,
  runtimeInjected: true,
  hostSafe: true,
  toolAvailable: true,
};

describe('decideHostDepsInstall', () => {
  it('installs on the host when every guard passes', () => {
    // breaks-if-wrong: the default agent (scripts disabled, runtime injected,
    // plain project, agent npm present) must install on the host.
    expect(decideHostDepsInstall(INSTALLABLE)).toBe(HostDepsInstall.Install);
  });

  it.each<[Partial<HostDepsInstallFacts>, HostDepsInstall]>([
    [{ hasDepsUrl: true }, HostDepsInstall.DepsFromCache],
    [{ hasKiciPackage: false }, HostDepsInstall.NoKiciPackage],
    [{ hasNodeModules: true }, HostDepsInstall.AlreadyInstalled],
    [{ allowInstallScripts: true }, HostDepsInstall.InstallScriptsAllowed],
    [{ runtimeInjected: false }, HostDepsInstall.ImageSuppliesNode],
    [{ hostSafe: false }, HostDepsInstall.NotHostSafe],
    [{ toolAvailable: false }, HostDepsInstall.PackageManagerUnavailable],
  ])('%o leaves the host alone: %s', (flip, expected) => {
    // fails-when: the guard for this fact is dropped, so the decision falls
    // through to Install.
    expect(decideHostDepsInstall({ ...INSTALLABLE, ...flip })).toBe(expected);
  });

  it('refuses install scripts before anything else that would install', () => {
    expect(
      decideHostDepsInstall({ ...INSTALLABLE, allowInstallScripts: true, runtimeInjected: false }),
    ).toBe(HostDepsInstall.InstallScriptsAllowed);
  });
});

const NPM_TOOL: HostInstallTool = {
  packageManager: PackageManager.Npm,
  nodeExe: '/opt/node/bin/node',
  script: '/opt/node/lib/node_modules/npm/bin/npm-cli.js',
  version: '11.19.1',
};

const TOKEN = 'npm_SECRETTOKEN_abc';
/** A plan's `.npmrc` inputs; the installer is stubbed, so the codec is never called. */
const NPMRC = {
  ini: { decode: () => ({}), encode: () => '' },
  operator: {},
  repo: { registry: 'https://registry.npmjs.org/' },
};
const REGISTRIES = [
  { scope: '@acme', url: 'https://npm.acme.internal/', alwaysAuth: false, token: TOKEN },
];
const INSTALL_SECRET = 'install-secret-xyz';

function makeArgs(overrides: Partial<InstallKiciDepsOnHostArgs> = {}): InstallKiciDepsOnHostArgs & {
  lines: string[];
} {
  const lines: string[] = [];
  return {
    workflowDir: '/work/workflow',
    dispatch: {
      jobId: 'job-12345678-abcd',
      npmRegistries: REGISTRIES,
      installEnvSecrets: { ACME_TOKEN: INSTALL_SECRET },
    },
    allowInstallScripts: false,
    runtimeInjected: true,
    baseEnv: { PATH: '/usr/bin' },
    log: (line) => lines.push(line),
    // package.json present, node_modules absent.
    fileExists: vi.fn(async (p: string) => p.endsWith('package.json')),
    checkEligibility: vi.fn(async () => ({
      eligible: true as const,
      plan: {
        packageManager: PackageManager.Npm as const,
        lockfile: 'package-lock.json',
        registries: [],
        npmrc: NPMRC,
      },
    })),
    resolveTool: vi.fn(async () => NPM_TOOL),
    checkLockedInstall: vi.fn(async () => null),
    runInstall: vi.fn(async () => undefined),
    lines,
    ...overrides,
  };
}

describe('installKiciDepsOnHost', () => {
  it('runs the isolated install with the plan, the pinned tool and the dispatch config', async () => {
    const signal = new AbortController().signal;
    const args = makeArgs({ signal });

    expect(await installKiciDepsOnHost(args)).toBe(HostDepsInstall.Install);

    // fails-when: the job's workflow registries are not handed to the check, so
    // one on an origin the operator did not allow reaches the host install.
    expect(args.checkEligibility).toHaveBeenCalledWith('/work/workflow', REGISTRIES);
    expect(args.resolveTool).toHaveBeenCalledWith(PackageManager.Npm);
    // fails-when: the lockfile check is skipped or handed another checkout, so
    // an npm that runs npm ci installs an unpinned lockfile.
    expect(args.checkLockedInstall).toHaveBeenCalledWith(
      '/work/workflow/.kici',
      {
        packageManager: PackageManager.Npm,
        lockfile: 'package-lock.json',
        registries: [],
        npmrc: NPMRC,
      },
      NPM_TOOL,
    );
    expect(args.runInstall).toHaveBeenCalledWith({
      kiciDir: '/work/workflow/.kici',
      plan: {
        packageManager: PackageManager.Npm,
        lockfile: 'package-lock.json',
        registries: [],
        npmrc: NPMRC,
      },
      tool: NPM_TOOL,
      registries: REGISTRIES,
      installEnvSecrets: { ACME_TOKEN: INSTALL_SECRET },
      jobIdShort: 'job-1234',
      baseEnv: { PATH: '/usr/bin' },
      // fails-when: the job's abort signal is not handed to the install, so a
      // cancel waits out the whole install.
      signal,
    });
    expect(args.lines).toEqual([
      '[host-install] Installing .kici dependencies on the agent host with npm 11.19.1',
      '[host-install] Dependencies installed',
    ]);
  });

  it('leaves a checkout outside the allowlist to the container, naming why', async () => {
    const args = makeArgs({
      checkEligibility: vi.fn(async () => ({
        eligible: false as const,
        refusal: HostInstallRefusal.PnpmHooks,
        detail: '.pnpmfile.cjs is present',
      })),
    });

    expect(await installKiciDepsOnHost(args)).toBe(HostDepsInstall.NotHostSafe);
    // fails-when: a refused checkout still reaches the installer.
    expect(args.runInstall).not.toHaveBeenCalled();
    expect(args.resolveTool).not.toHaveBeenCalled();
    expect(args.lines).toEqual([
      '[host-install] The .kici install cannot run on the agent host (pnpm-hooks: .pnpmfile.cjs is present), so the job container installs the .kici dependencies',
    ]);
  });

  it('leaves the install to the container when the tool cannot keep the lockfile pinned', async () => {
    const args = makeArgs({
      resolveTool: vi.fn(async () => ({ ...NPM_TOOL, version: '11.12.1' })),
      checkLockedInstall: vi.fn(async () => ({
        eligible: false as const,
        refusal: HostInstallRefusal.LockfileUnpinned,
        detail:
          '.kici/package-lock.json: the project depends on foo@1.0.0, which the lockfile does not pin',
      })),
    });

    expect(await installKiciDepsOnHost(args)).toBe(HostDepsInstall.NotHostSafe);
    // fails-when: a refused lockfile still reaches the installer, whose npm ci
    // fetches the unpinned package's own URL dependency from the agent host.
    expect(args.runInstall).not.toHaveBeenCalled();
    expect(args.lines).toEqual([
      '[host-install] The .kici install cannot run on the agent host (lockfile-unpinned: .kici/package-lock.json: the project depends on foo@1.0.0, which the lockfile does not pin), so the job container installs the .kici dependencies',
    ]);
  });

  it('leaves the install to the container when the agent has no pinned package manager', async () => {
    const args = makeArgs({ resolveTool: vi.fn(async () => null) });

    expect(await installKiciDepsOnHost(args)).toBe(HostDepsInstall.PackageManagerUnavailable);
    expect(args.runInstall).not.toHaveBeenCalled();
  });

  it('does not inspect the checkout when a cheap guard already decides', async () => {
    const args = makeArgs({ allowInstallScripts: true });

    expect(await installKiciDepsOnHost(args)).toBe(HostDepsInstall.InstallScriptsAllowed);
    expect(args.checkEligibility).not.toHaveBeenCalled();
    expect(args.lines).toEqual([
      '[host-install] Install scripts are allowed on this agent, so the job container installs the .kici dependencies',
    ]);
  });

  it('redacts registry tokens and install secrets from the logged and rethrown error', async () => {
    const stderr = `npm error 401 Unauthorized - GET https://npm.acme.internal/@acme%2flib (token ${TOKEN}, secret ${INSTALL_SECRET})`;
    const args = makeArgs({ runInstall: vi.fn(async () => Promise.reject(new Error(stderr))) });

    const thrown = (await installKiciDepsOnHost(args).catch((err: unknown) => err)) as Error;

    // fails-when: the raw execFile error is logged or rethrown, so a token the
    // installer echoes reaches the run log and job.status.error.
    expect(thrown).toBeInstanceOf(Error);
    expect(thrown.message).not.toContain(TOKEN);
    expect(thrown.message).not.toContain(INSTALL_SECRET);
    expect(thrown.message).toContain('401 Unauthorized');
    expect(args.lines.join('\n')).not.toContain(TOKEN);
    expect(args.lines.join('\n')).not.toContain(INSTALL_SECRET);
    expect(args.lines.at(-1)).toMatch(/^\[host-install\] \[error\] npm error 401/);
  });
});

describe('hostInstallSecrets', () => {
  it('lists every registry token and install secret value', () => {
    expect(
      hostInstallSecrets({
        npmRegistries: [{ url: 'https://r/', alwaysAuth: false, token: 't1' }],
        installEnvSecrets: { A: 's1', B: '' },
      }),
    ).toEqual(['t1', 's1']);
  });
});

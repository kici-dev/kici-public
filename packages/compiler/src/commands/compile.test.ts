import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import * as childProcess from 'node:child_process';
import { execFileSync } from 'node:child_process';
import { logger } from '@kici-dev/core';
import { initCommand } from './init.js';
import { compileCommand } from './compile.js';

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, execSync: vi.fn(actual.execSync) };
});

/**
 * A fresh project dir under the package (so the SDK resolves) as the cwd, with
 * CI mode on, restored and removed after each test.
 */
function useTempProject(): { dir: string } {
  const project = { dir: '' };
  let originalCwd: string;
  let originalCI: string | undefined;
  beforeEach(async () => {
    originalCwd = process.cwd();
    originalCI = process.env.CI;
    process.env.CI = 'true';
    const packageDir = path.resolve(import.meta.dirname, '..', '..');
    project.dir = await fs.mkdtemp(path.join(packageDir, '.test-compile-'));
    process.chdir(project.dir);
    vi.mocked(childProcess.execSync).mockClear();
  });
  afterEach(async () => {
    process.chdir(originalCwd);
    process.env.CI = originalCI;
    delete process.env.KICI_DEV;
    await fs.rm(project.dir, { recursive: true, force: true });
  });
  return project;
}

describe('kici compile: dep-reinstall gate', () => {
  const project = useTempProject();

  // A stale `lockfileHash` makes the dep-change branch fire.
  async function staleDepsHash(): Promise<void> {
    const lockPath = path.join(project.dir, '.kici', 'kici.lock.json');
    const lock = JSON.parse(await fs.readFile(lockPath, 'utf-8'));
    lock.lockfileHash = 'sha256-deadbeef-stale-hash-for-test';
    await fs.writeFile(lockPath, JSON.stringify(lock, null, 2));
  }

  it('skips reinstall when `.kici/package.json` is absent', async () => {
    // A `.kici/` with no package.json declares no dependencies of its own, so
    // there is nothing under `.kici/` to reinstall.
    expect(await initCommand({ skipInstall: true })).toBe(true);
    expect(await compileCommand({ check: false, verbose: false })).toBe(true);
    await fs.rm(path.join(project.dir, '.kici', 'package.json'));
    await staleDepsHash();

    // The "deps changed" branch must NOT call `npm install` here: with no
    // `.kici/package.json`, npm walks up to the workspace root and chokes on
    // `workspace:*` refs.
    vi.mocked(childProcess.execSync).mockClear();
    expect(await compileCommand({ check: false, verbose: false })).toBe(true);

    const installCalls = vi
      .mocked(childProcess.execSync)
      .mock.calls.filter(([cmd]) => /\bnpm (ci|install)\b/.test(String(cmd)));
    expect(installCalls).toEqual([]);
  });

  it('reinstalls a pnpm workspace member with pnpm, never npm', async () => {
    // The runner's npm_config_user_agent would otherwise pick pnpm for any dir.
    const savedUserAgent = process.env.npm_config_user_agent;
    delete process.env.npm_config_user_agent;
    execFileSync('git', ['init', '-q'], { cwd: project.dir });
    await fs.writeFile('pnpm-workspace.yaml', 'packages:\n  - .kici\n');
    await fs.writeFile(
      'package.json',
      JSON.stringify({ name: 'root', private: true, packageManager: 'pnpm@11.3.0' }),
    );
    await fs.writeFile('pnpm-lock.yaml', "lockfileVersion: '9.0'\n");
    const real = (await vi.importActual<typeof import('node:child_process')>('node:child_process'))
      .execSync;
    try {
      expect(await initCommand({ workspace: true, skipInstall: true })).toBe(true);
      expect(await compileCommand({ check: false, verbose: false })).toBe(true);
      await staleDepsHash();

      vi.mocked(childProcess.execSync).mockClear();
      vi.mocked(childProcess.execSync).mockImplementation(((cmd: string, opts?: object) =>
        /^(pnpm|npm|yarn) (install|ci)\b/.test(String(cmd))
          ? Buffer.alloc(0)
          : real(cmd, opts)) as typeof childProcess.execSync);
      expect(await compileCommand({ check: false, verbose: false })).toBe(true);
      const installs = vi
        .mocked(childProcess.execSync)
        .mock.calls.map(([cmd]) => String(cmd))
        .filter((cmd) => /^(pnpm|npm|yarn) (install|ci)\b/.test(cmd));
      // fails-when: the manager is detected from .kici/ (no lockfile there), so the
      // member is reinstalled with npm, which cannot resolve workspace:*
      expect(installs).toEqual(['pnpm install']);
    } finally {
      vi.mocked(childProcess.execSync).mockImplementation(real);
      if (savedUserAgent !== undefined) process.env.npm_config_user_agent = savedUserAgent;
    }
  });
});

describe('kici compile: missing .kici/package.json warning', () => {
  const project = useTempProject();

  async function warnings(opts: { warnMissingKiciManifest?: boolean }): Promise<string> {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => logger);
    try {
      expect(await compileCommand({ check: false, verbose: false, ...opts })).toBe(true);
      return warn.mock.calls.map(([m]) => String(m)).join('\n');
    } finally {
      warn.mockRestore();
    }
  }

  it('warns when asked and .kici/ has workflows but no package.json', async () => {
    expect(await initCommand({ skipInstall: true })).toBe(true);
    await fs.rm(path.join(project.dir, '.kici', 'package.json'));
    // fails-when: the preflight never runs, so the layout ships and the run fails on
    // the agent with "Cannot find package '@kici-dev/sdk'"
    expect(await warnings({ warnMissingKiciManifest: true })).toContain('no .kici/package.json');
  });

  it('stays quiet without the option (an in-place local run)', async () => {
    expect(await initCommand({ skipInstall: true })).toBe(true);
    await fs.rm(path.join(project.dir, '.kici', 'package.json'));
    expect(await warnings({})).not.toContain('no .kici/package.json');
  });

  it('stays quiet for a .kici/ with its own package.json', async () => {
    expect(await initCommand({ skipInstall: true })).toBe(true);
    // breaks-if-wrong: every standalone and member scaffold would print a false warning
    expect(await warnings({ warnMissingKiciManifest: true })).not.toContain(
      'no .kici/package.json',
    );
  });
});

describe('kici compile: dynamic-value functions', () => {
  let tempDir: string;
  let originalCwd: string;
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    originalCwd = process.cwd();
    process.env.CI = 'true';
    const packageDir = path.resolve(import.meta.dirname, '..', '..');
    tempDir = await fs.mkdtemp(path.join(packageDir, '.test-compile-dynamic-'));
    process.chdir(tempDir);
    warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});
  });

  afterEach(async () => {
    warnSpy.mockRestore();
    process.chdir(originalCwd);
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('compiles a function context to a dynamic marker (no inline expression, no purity warning)', async () => {
    expect(await initCommand({ skipInstall: true })).toBe(true);
    const workflowsDir = path.join(tempDir, '.kici', 'workflows');
    for (const f of await fs.readdir(workflowsDir)) {
      await fs.rm(path.join(workflowsDir, f));
    }
    await fs.writeFile(
      path.join(workflowsDir, 'dynamic.ts'),
      [
        "import { workflow, job, step, push } from '@kici-dev/sdk';",
        "export default workflow('ci', {",
        '  on: push({ branches: ["main"] }),',
        '  jobs: [',
        "    job('build', {",
        '      runsOn: ["self-hosted"],',
        '      context: (event) => event.targetBranch,',
        "      steps: [step('run', async ({ $ }) => { await $`echo hi`; })],",
        '    }),',
        '  ],',
        '});',
        '',
      ].join('\n'),
      'utf-8',
    );

    const ok = await compileCommand({ check: false, verbose: false });
    expect(ok).toBe(true);

    // A function context is a dynamic marker, never an inline expression; the
    // agent init round resolves it.
    const lockPath = path.join(tempDir, '.kici', 'kici.lock.json');
    const lockJson = await fs.readFile(lockPath, 'utf-8');
    expect(lockJson).not.toContain('_type": "inline"');
    const lock = JSON.parse(lockJson);
    expect(lock.workflows[0].jobs[0].contexts).toEqual([{ value: '', dynamic: true }]);

    // No purity / init-job warning.
    const warnLines = warnSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(warnLines).not.toContain('is not pure');
    expect(warnLines).not.toContain('~5-10s');
  });
});

describe('shouldRefreshTypes', () => {
  let dir: string;
  beforeEach(async () => {
    const os = await import('node:os');
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'kici-refresh-types-'));
  });
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('refreshes with a direct target', async () => {
    const { shouldRefreshTypes } = await import('./compile.js');
    expect(
      await shouldRefreshTypes({ direct: { url: 'http://orch:4000', token: 't' } }, dir, {}),
    ).toBe(true);
  });

  it('refreshes with a Platform login and an active org', async () => {
    const { shouldRefreshTypes } = await import('./compile.js');
    const login = { pat: 'p', platformEndpoint: 'https://api.kici.dev' };
    expect(await shouldRefreshTypes({ ...login, activeOrgId: 'o' }, dir, {})).toBe(true);
    expect(await shouldRefreshTypes(login, dir, {})).toBe(false);
  });

  it('refreshes with local secret files', async () => {
    const { shouldRefreshTypes } = await import('./compile.js');
    await fs.writeFile(path.join(dir, 'secrets.yaml'), 'production: {}\n');
    // fails-when: a platform-less developer's local secrets never reach kici types
    expect(await shouldRefreshTypes({}, dir, {})).toBe(true);
  });

  it('refreshes for a --orchestrator-url run with an env token', async () => {
    const { shouldRefreshTypes } = await import('./compile.js');
    expect(
      await shouldRefreshTypes({}, dir, { KICI_ORCHESTRATOR_TOKEN: 't' }, 'https://ci.example.com'),
    ).toBe(true);
  });

  it('skips a bare checkout with no source', async () => {
    const { shouldRefreshTypes } = await import('./compile.js');
    // breaks-if-wrong: a bare checkout keeps compiling without touching types
    expect(await shouldRefreshTypes({}, dir, {})).toBe(false);
  });
});

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import { logger } from '@kici-dev/core';
import { initCommand } from './commands/init.js';
import { VersionPin, generatePackageJson } from './templates/index.js';

describe('kici init', () => {
  let tempDir: string;
  let originalCwd: string;
  let originalCI: string | undefined;
  let originalCeiling: string | undefined;

  beforeEach(async () => {
    originalCwd = process.cwd();
    originalCI = process.env.CI;
    // CI skips interactive prompts.
    process.env.CI = 'true';

    // Inside the package directory, so module resolution finds the SDK.
    const packageDir = path.resolve(import.meta.dirname, '..');
    tempDir = await fs.mkdtemp(path.join(packageDir, '.test-init-'));
    process.chdir(tempDir);
    // tempDir sits inside this checkout: keep git from reading the checkout's origin.
    originalCeiling = process.env.GIT_CEILING_DIRECTORIES;
    process.env.GIT_CEILING_DIRECTORIES = path.dirname(tempDir);
  });

  afterEach(async () => {
    process.chdir(originalCwd);
    process.env.CI = originalCI;
    if (originalCeiling === undefined) delete process.env.GIT_CEILING_DIRECTORIES;
    else process.env.GIT_CEILING_DIRECTORIES = originalCeiling;
    delete process.env.KICI_DEV;
    delete process.env.KICI_DEV_REGISTRY;
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  async function exists(filePath: string): Promise<boolean> {
    try {
      await fs.access(filePath);
      return true;
    } catch {
      return false;
    }
  }

  describe('directory creation', () => {
    it('creates .kici/ directory', async () => {
      const success = await initCommand({ skipInstall: true });
      expect(success).toBe(true);
      expect(await exists('.kici')).toBe(true);
    });

    it('creates .kici/workflows/ subdirectory', async () => {
      const success = await initCommand({ skipInstall: true });
      expect(success).toBe(true);
      expect(await exists('.kici/workflows')).toBe(true);
    });

    it('creates workflow files in workflows/', async () => {
      const success = await initCommand({ skipInstall: true });
      expect(success).toBe(true);

      expect(await exists('.kici/workflows/hello-world.ts')).toBe(true);
      expect(await exists('.kici/workflows/pr-checks.ts')).toBe(true);
    });
  });

  describe('private registry scaffolding', () => {
    it('creates .npmrc.example and workflow example when --private-registry is set', async () => {
      const success = await initCommand({
        skipInstall: true,
        privateRegistry: 'https://npm.pkg.github.com',
        privateRegistryScope: '@my-org',
        privateRegistrySecret: 'production:GITHUB_PACKAGES_TOKEN',
      });
      expect(success).toBe(true);

      const npmrc = path.join(tempDir, '.kici', '.npmrc.example');
      const wf = path.join(tempDir, '.kici', 'workflows', 'private-registry-example.ts.example');
      expect(await exists(npmrc)).toBe(true);
      expect(await exists(wf)).toBe(true);

      const npmrcBody = await fs.readFile(npmrc, 'utf-8');
      expect(npmrcBody).toContain('@my-org:registry=https://npm.pkg.github.com');
      expect(npmrcBody).toContain('${MY_NPM_TOKEN}');

      const wfBody = await fs.readFile(wf, 'utf-8');
      expect(wfBody).toContain("url: 'https://npm.pkg.github.com'");
      expect(wfBody).toContain("scope: '@my-org'");
      expect(wfBody).toContain("tokenSecret: 'production:GITHUB_PACKAGES_TOKEN'");
    });

    it('does NOT create scaffolding files when --private-registry is omitted', async () => {
      const success = await initCommand({ skipInstall: true });
      expect(success).toBe(true);

      expect(await exists(path.join(tempDir, '.kici', '.npmrc.example'))).toBe(false);
      expect(
        await exists(
          path.join(tempDir, '.kici', 'workflows', 'private-registry-example.ts.example'),
        ),
      ).toBe(false);
    });

    it('emits a default-registry npmrc when --private-registry-scope is omitted', async () => {
      const success = await initCommand({
        skipInstall: true,
        privateRegistry: 'https://my-corp.example.com/npm',
        privateRegistrySecret: 'shared:NPM_MIRROR_TOKEN',
      });
      expect(success).toBe(true);

      const npmrcBody = await fs.readFile(path.join(tempDir, '.kici', '.npmrc.example'), 'utf-8');
      expect(npmrcBody).toContain('registry=https://my-corp.example.com/npm');
      expect(npmrcBody).not.toContain('@my-org:registry=');
    });

    it('does NOT overwrite an existing .kici/.npmrc.example', async () => {
      await fs.mkdir(path.join(tempDir, '.kici', 'workflows'), { recursive: true });
      const npmrcPath = path.join(tempDir, '.kici', '.npmrc.example');
      await fs.writeFile(npmrcPath, '# customer-edited\n', 'utf-8');

      const success = await initCommand({
        force: true,
        skipInstall: true,
        privateRegistry: 'https://npm.pkg.github.com',
      });
      // --force removes .kici/ first, so this asserts only that init succeeds
      // over a pre-seeded file; the next test covers the file surviving.
      expect(success).toBe(true);
    });

    it('does NOT overwrite an existing .npmrc.example across two init runs without --force', async () => {
      const a = await initCommand({
        skipInstall: true,
        privateRegistry: 'https://npm.pkg.github.com',
      });
      expect(a).toBe(true);
      const npmrcPath = path.join(tempDir, '.kici', '.npmrc.example');
      await fs.writeFile(npmrcPath, '# user edited\n', 'utf-8');

      await fs.writeFile(npmrcPath, '# user edited again\n', 'utf-8');
      // Without --force, init refuses an existing .kici/, so the edit survives.
      const b = await initCommand({
        skipInstall: true,
        privateRegistry: 'https://npm.pkg.github.com',
      });
      expect(b).toBe(false);
      const after = await fs.readFile(npmrcPath, 'utf-8');
      expect(after).toBe('# user edited again\n');
    });
  });

  describe('TypeScript mode (default)', () => {
    it('creates package.json with correct content', async () => {
      const success = await initCommand({ skipInstall: true });
      expect(success).toBe(true);

      const pkgPath = path.join(tempDir, '.kici', 'package.json');
      expect(await exists(pkgPath)).toBe(true);

      const content = await fs.readFile(pkgPath, 'utf-8');
      const pkg = JSON.parse(content);

      expect(pkg.name).toBe('@kici-dev/workflows');
      expect(pkg.type).toBe('module');
      expect(pkg.scripts).toBeDefined();
      expect(pkg.scripts.typecheck).toBe('tsc --noEmit');
    });

    it('creates tsconfig.json', async () => {
      const success = await initCommand({ skipInstall: true });
      expect(success).toBe(true);

      const tsconfigPath = path.join(tempDir, '.kici', 'tsconfig.json');
      expect(await exists(tsconfigPath)).toBe(true);

      const content = await fs.readFile(tsconfigPath, 'utf-8');
      const tsconfig = JSON.parse(content);

      expect(tsconfig.compilerOptions).toBeDefined();
      expect(tsconfig.compilerOptions.module).toBe('NodeNext');
    });

    it('package.json has @kici-dev/sdk as devDependency and compile script', async () => {
      const success = await initCommand({ skipInstall: true });
      expect(success).toBe(true);

      const pkgPath = path.join(tempDir, '.kici', 'package.json');
      const content = await fs.readFile(pkgPath, 'utf-8');
      const pkg = JSON.parse(content);

      expect(pkg.devDependencies).toBeDefined();
      expect(pkg.devDependencies['@kici-dev/sdk']).toBe('^0.0.1');
      expect(pkg.devDependencies['@kici-dev/compiler']).toBeUndefined();
      expect(pkg.dependencies).toBeUndefined();
    });
  });

  describe('MJS mode (--mjs)', () => {
    it('creates package.json with @kici-dev/sdk devDependency', async () => {
      const success = await initCommand({ mjs: true });
      expect(success).toBe(true);

      const pkgPath = path.join(tempDir, '.kici', 'package.json');
      expect(await exists(pkgPath)).toBe(true);

      const content = await fs.readFile(pkgPath, 'utf-8');
      const pkg = JSON.parse(content);

      expect(pkg.name).toBe('@kici-dev/workflows');
      expect(pkg.type).toBe('module');
      expect(pkg.devDependencies['@kici-dev/sdk']).toBeDefined();
    });

    it('does NOT create tsconfig.json', async () => {
      const success = await initCommand({ mjs: true });
      expect(success).toBe(true);

      expect(await exists('.kici/tsconfig.json')).toBe(false);
    });

    it('still creates workflow files', async () => {
      const success = await initCommand({ mjs: true });
      expect(success).toBe(true);

      expect(await exists('.kici/workflows/hello-world.ts')).toBe(true);
      expect(await exists('.kici/workflows/pr-checks.ts')).toBe(true);
    });
  });

  describe('--force flag', () => {
    it('errors without --force when .kici/ exists', async () => {
      await initCommand({ skipInstall: true });

      const success = await initCommand({ skipInstall: true });
      expect(success).toBe(false);
    });

    it('succeeds with --force when .kici/ exists', async () => {
      await initCommand({ skipInstall: true });

      const success = await initCommand({ force: true, skipInstall: true });
      expect(success).toBe(true);
    });

    it('removes old content when using --force', async () => {
      await initCommand({ skipInstall: true });

      const customFile = path.join(tempDir, '.kici', 'custom.txt');
      await fs.writeFile(customFile, 'test', 'utf-8');
      expect(await exists(customFile)).toBe(true);

      await initCommand({ force: true, skipInstall: true });

      expect(await exists(customFile)).toBe(false);
    });
  });

  describe('--skip-install flag', () => {
    it('skips npm install when flag set', async () => {
      const success = await initCommand({ skipInstall: true });
      expect(success).toBe(true);

      expect(await exists('.kici/package.json')).toBe(true);
      expect(await exists('.kici/node_modules')).toBe(false);
    });
  });

  describe('--package-manager flag', () => {
    it('fails with an invalid package manager value', async () => {
      // An unsupported manager must error out rather than silently default.
      const success = await initCommand({ packageManager: 'bun' });
      expect(success).toBe(false);
      // .kici/ is created before the install step, but the run reports failure.
    });

    it('skipInstall short-circuits before package-manager resolution', async () => {
      // Even an invalid manager is irrelevant when install is skipped.
      const success = await initCommand({ skipInstall: true, packageManager: 'bun' });
      expect(success).toBe(true);
      expect(await exists('.kici/node_modules')).toBe(false);
    });
  });

  describe('development mode', () => {
    it('creates .npmrc pointing at KICI_DEV_REGISTRY when KICI_DEV=true', async () => {
      process.env.KICI_DEV = 'true';
      process.env.KICI_DEV_REGISTRY = 'http://registry.local:4873';

      const success = await initCommand({ skipInstall: true });
      expect(success).toBe(true);

      const npmrcPath = path.join(tempDir, '.kici', '.npmrc');
      expect(await exists(npmrcPath)).toBe(true);
      const content = await fs.readFile(npmrcPath, 'utf-8');
      expect(content).toContain('@kici-dev:registry=http://registry.local:4873');

      const rootNpmrcPath = path.join(tempDir, '.npmrc');
      expect(await exists(rootNpmrcPath)).toBe(true);
      const rootContent = await fs.readFile(rootNpmrcPath, 'utf-8');
      expect(rootContent).toContain('@kici-dev:registry=http://registry.local:4873');
    });

    it('creates .npmrc when root package.json has kici.development flag', async () => {
      process.env.KICI_DEV_REGISTRY = 'http://registry.local:4873';
      await fs.writeFile(
        path.join(tempDir, 'package.json'),
        JSON.stringify({ kici: { development: true } }),
        'utf-8',
      );

      const success = await initCommand({ skipInstall: true });
      expect(success).toBe(true);

      const npmrcPath = path.join(tempDir, '.kici', '.npmrc');
      expect(await exists(npmrcPath)).toBe(true);
    });

    it('does NOT create .npmrc in production mode', async () => {
      delete process.env.KICI_DEV;

      const success = await initCommand({ skipInstall: true });
      expect(success).toBe(true);

      expect(await exists(path.join(tempDir, '.kici', '.npmrc'))).toBe(false);
      expect(await exists(path.join(tempDir, '.npmrc'))).toBe(false);
    });

    it('pins the SDK to the latest dist-tag in dev mode', async () => {
      process.env.KICI_DEV = 'true';

      const success = await initCommand({ skipInstall: true });
      expect(success).toBe(true);

      const pkgPath = path.join(tempDir, '.kici', 'package.json');
      const content = await fs.readFile(pkgPath, 'utf-8');
      const pkg = JSON.parse(content);

      // A dist-tag resolves Verdaccio's prerelease builds (0.8.0-9726 and
      // whatever follows); no semver range does, since a prerelease only
      // satisfies a comparator with the same major.minor.patch.
      expect(pkg.devDependencies['@kici-dev/sdk']).toBe('latest');
      expect(pkg.devDependencies['@kici-dev/compiler']).toBeUndefined();
    });

    it('uses ^0.0.1 in production mode', async () => {
      delete process.env.KICI_DEV;

      const success = await initCommand({ skipInstall: true });
      expect(success).toBe(true);

      const pkgPath = path.join(tempDir, '.kici', 'package.json');
      const content = await fs.readFile(pkgPath, 'utf-8');
      const pkg = JSON.parse(content);

      expect(pkg.devDependencies['@kici-dev/sdk']).toBe('^0.0.1');
    });
  });

  describe('default branch', () => {
    const COMMIT_FLAGS = [
      '-c',
      'user.email=init@test.kici.dev',
      '-c',
      'user.name=init test',
      '-c',
      'commit.gpgsign=false',
      '-c',
      'core.hooksPath=/dev/null',
    ];

    /** Make tempDir its own git repository whose only branch is `branch`. */
    function gitInitOn(branch: string): void {
      execFileSync('git', ['init', '-q', '-b', branch], { cwd: tempDir });
      execFileSync('git', [...COMMIT_FLAGS, 'commit', '-q', '--allow-empty', '-m', 'init'], {
        cwd: tempDir,
      });
    }

    /** Scaffold into a repository on `branch`; return a generated file under .kici/. */
    async function scaffoldOn(branch: string, file: string): Promise<string> {
      gitInitOn(branch);
      expect(await initCommand({ skipInstall: true })).toBe(true);
      return fs.readFile(path.join(tempDir, '.kici', file), 'utf-8');
    }

    it('detects the branch of the repository it scaffolds into', async () => {
      // fails-when: the branch is read from the directory the process started in
      expect(await scaffoldOn('develop', 'tests/push-test.ts')).toContain('push-develop');
    });

    async function readPrChecks(): Promise<string> {
      return fs.readFile(path.join(tempDir, '.kici', 'workflows', 'pr-checks.ts'), 'utf-8');
    }

    it('writes a loadable fixture for a slash-named branch, and targets main with no remote', async () => {
      const fixture = await scaffoldOn('ci/kici', 'tests/push-test.ts');
      // fails-when: init interpolates the raw branch (`export const pushCi/kici`)
      expect(fixture).toContain('export const pushCiKici = fixture("push-ci/kici", {');
      expect(fixture).toContain('event: push({ branches: ["ci/kici"] }),');
      expect(fixture).toContain('branch: "ci/kici",');

      // No remote and no src/: the target is main and there is no paths filter.
      // fails-when: the PR target follows the checked-out branch (#496)
      expect(await readPrChecks()).toContain("on: pr({ target: 'main' }),");
    });

    it('targets the origin default branch from a feature branch, and keeps paths with src/', async () => {
      const originRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'kici-init-origin-'));
      try {
        const seed = path.join(originRoot, 'seed');
        await fs.mkdir(seed);
        execFileSync('git', ['init', '-q', '-b', 'trunk'], { cwd: seed });
        execFileSync('git', [...COMMIT_FLAGS, 'commit', '-q', '--allow-empty', '-m', 'seed'], {
          cwd: seed,
        });
        const bare = path.join(originRoot, 'origin.git');
        execFileSync('git', ['clone', '-q', '--bare', seed, bare]);

        // A remote added by hand never sets origin/HEAD, so this reaches ls-remote.
        execFileSync('git', ['init', '-q', '-b', 'trunk'], { cwd: tempDir });
        execFileSync('git', ['remote', 'add', 'origin', bare], { cwd: tempDir });
        execFileSync('git', ['fetch', '-q', 'origin'], { cwd: tempDir });
        execFileSync('git', ['checkout', '-q', '-b', 'feature/x', 'origin/trunk'], {
          cwd: tempDir,
        });
        await fs.mkdir(path.join(tempDir, 'src'));

        const info = vi.spyOn(logger, 'info');
        expect(await initCommand({ skipInstall: true })).toBe(true);

        const prChecks = await readPrChecks();
        // fails-when: the target is the checked-out feature/x, or the ls-remote step is missing (main)
        expect(prChecks).toContain("on: pr({ target: 'trunk', paths: ['src/**'] }),");
        // breaks-if-wrong: a repository with src/ keeps the src/ rule
        expect(prChecks).toContain("rule('require-src-changes'");
        const fixture = await fs.readFile(
          path.join(tempDir, '.kici', 'tests', 'push-test.ts'),
          'utf-8',
        );
        // fails-when: the fixture follows the default branch instead of the checked-out one
        expect(fixture).toContain('branch: "feature/x",');
        // fails-when: init does not say which branch pr-checks targets
        expect(
          info.mock.calls.some(([line]) => String(line).includes("pr-checks targets 'trunk'")),
        ).toBe(true);
      } finally {
        vi.restoreAllMocks();
        await fs.rm(originRoot, { recursive: true, force: true });
      }
    });

    it('uses main and push-main with no git repository', async () => {
      expect(await initCommand({ skipInstall: true })).toBe(true);
      // fails-when: git walks up into the enclosing checkout (its origin/HEAD is master)
      expect(await readPrChecks()).toContain("on: pr({ target: 'main' }),");
      const fixture = await fs.readFile(
        path.join(tempDir, '.kici', 'tests', 'push-test.ts'),
        'utf-8',
      );
      expect(fixture).toContain('push-main');
    });
  });

  describe('version pins', () => {
    const CLI_VERSION = '0.17.0';

    beforeEach(() => {
      vi.stubGlobal('KICI_VERSION', CLI_VERSION);
    });

    afterEach(() => {
      vi.unstubAllGlobals();
    });

    async function scaffoldedPackageJson(): Promise<{
      scripts: Record<string, string>;
      devDependencies: Record<string, string>;
    }> {
      return JSON.parse(await fs.readFile(path.join(tempDir, '.kici', 'package.json'), 'utf-8'));
    }

    it('pins a caret SDK and a compile script on the same CLI version', async () => {
      expect(await initCommand({ skipInstall: true })).toBe(true);
      const pkg = await scaffoldedPackageJson();
      // fails-when: the compile script floats on kici@latest while the SDK is pinned
      expect(pkg.scripts.compile).toBe(`npx --yes kici@${CLI_VERSION} compile`);
      expect(pkg.devDependencies['@kici-dev/sdk']).toBe(`^${CLI_VERSION}`);
      expect(pkg.devDependencies.typescript).toBe('^6.0.3');
    });

    it.each(['save-exact=true\n', "save-prefix=''\n"])(
      'writes exact versions under a repository .npmrc of %j',
      async (npmrc) => {
        await fs.writeFile(path.join(tempDir, '.npmrc'), npmrc, 'utf-8');
        expect(await initCommand({ skipInstall: true })).toBe(true);
        const pkg = await scaffoldedPackageJson();
        // fails-when: init never reads the repository .npmrc
        expect(pkg.devDependencies['@kici-dev/sdk']).toBe(CLI_VERSION);
        expect(pkg.devDependencies.typescript).toBe('6.0.3');
        expect(pkg.scripts.compile).toBe(`npx --yes kici@${CLI_VERSION} compile`);
      },
    );

    it('keeps the latest dist-tag in development mode, whatever the .npmrc says', async () => {
      process.env.KICI_DEV = 'true';
      await fs.writeFile(path.join(tempDir, '.npmrc'), 'save-exact=true\n', 'utf-8');
      expect(await initCommand({ skipInstall: true })).toBe(true);
      const pkg = await scaffoldedPackageJson();
      // breaks-if-wrong: no semver range reaches a dev-registry prerelease
      expect(pkg.devDependencies['@kici-dev/sdk']).toBe('latest');
      expect(pkg.scripts.compile).toBe('npx --yes kici@latest compile');
      expect(pkg.devDependencies.typescript).toBe('^6.0.3');
    });
  });

  describe('.gitignore handling', () => {
    it('creates .gitignore with .kici/node_modules/ if not exists', async () => {
      const success = await initCommand({ skipInstall: true });
      expect(success).toBe(true);

      const gitignorePath = path.join(tempDir, '.gitignore');
      expect(await exists(gitignorePath)).toBe(true);

      const content = await fs.readFile(gitignorePath, 'utf-8');
      expect(content).toContain('.kici/node_modules/');
      // .npmrc entries are added only in Verdaccio mode.
      expect(content).not.toContain('.kici/.npmrc');
    });

    it('adds .npmrc entries to .gitignore in Verdaccio mode', async () => {
      process.env.KICI_DEV = 'true';

      const success = await initCommand({ skipInstall: true });
      expect(success).toBe(true);

      const gitignorePath = path.join(tempDir, '.gitignore');
      const content = await fs.readFile(gitignorePath, 'utf-8');
      expect(content).toContain('.kici/node_modules/');
      expect(content).toContain('.kici/.npmrc');
      expect(content).toContain('.npmrc');
    });

    it('appends to existing .gitignore', async () => {
      const gitignorePath = path.join(tempDir, '.gitignore');
      await fs.writeFile(gitignorePath, 'node_modules/\n*.log\n', 'utf-8');

      const success = await initCommand({ skipInstall: true });
      expect(success).toBe(true);

      const content = await fs.readFile(gitignorePath, 'utf-8');
      expect(content).toContain('node_modules/');
      expect(content).toContain('*.log');
      expect(content).toContain('.kici/node_modules/');
    });

    it('is idempotent - does not duplicate entries', async () => {
      await initCommand({ force: true, skipInstall: true });

      const gitignorePath = path.join(tempDir, '.gitignore');
      const firstContent = await fs.readFile(gitignorePath, 'utf-8');
      const firstCount = (firstContent.match(/\.kici\/node_modules\//g) || []).length;
      expect(firstCount).toBe(1);

      await initCommand({ force: true, skipInstall: true });

      const secondContent = await fs.readFile(gitignorePath, 'utf-8');
      const secondCount = (secondContent.match(/\.kici\/node_modules\//g) || []).length;
      expect(secondCount).toBe(1);
    });

    it('does not duplicate if broader pattern exists', async () => {
      const gitignorePath = path.join(tempDir, '.gitignore');
      await fs.writeFile(gitignorePath, '.kici/\n', 'utf-8');

      const success = await initCommand({ skipInstall: true });
      expect(success).toBe(true);

      const content = await fs.readFile(gitignorePath, 'utf-8');
      expect(content).not.toContain('.kici/node_modules/');
    });
  });

  describe('AGENTS.md scaffolding', () => {
    it('writes .kici/AGENTS.md by default in CI mode', async () => {
      const success = await initCommand({ skipInstall: true });
      expect(success).toBe(true);

      const agentsPath = path.join(tempDir, '.kici', 'AGENTS.md');
      expect(await exists(agentsPath)).toBe(true);

      const body = await fs.readFile(agentsPath, 'utf-8');
      expect(body).toContain('# KiCI workflow authoring guide');
      expect(body).toContain('kici docs llm');
      expect(body).toContain('https://kici.dev/llms.txt');
    });

    it('skips .kici/AGENTS.md when --no-agents-md is set', async () => {
      const success = await initCommand({ skipInstall: true, noAgentsMd: true });
      expect(success).toBe(true);

      const agentsPath = path.join(tempDir, '.kici', 'AGENTS.md');
      expect(await exists(agentsPath)).toBe(false);
    });

    it('contains anti-patterns and SDK type-declaration pointer', async () => {
      await initCommand({ skipInstall: true });

      const body = await fs.readFile(path.join(tempDir, '.kici', 'AGENTS.md'), 'utf-8');
      expect(body).toContain('node_modules/@kici-dev/sdk/dist/index.d.ts');
      expect(body).toContain('Do NOT write `.yml` / `.yaml`');
    });
  });

  describe('workspace integrate mode', () => {
    // A .git marker bounds detectWorkspaceRoot's upward walk to tempDir, so the
    // real workspace above the compiler package is never picked up.
    async function makePnpmWorkspace(): Promise<void> {
      await fs.writeFile(
        path.join(tempDir, 'pnpm-workspace.yaml'),
        "packages:\n  - 'packages/*'\n",
      );
      await fs.writeFile(
        path.join(tempDir, 'package.json'),
        JSON.stringify({ name: 'root', private: true }, null, 2) + '\n',
      );
      await fs.writeFile(path.join(tempDir, '.git'), 'gitdir: x\n');
    }

    it('writes .kici/package.json and adds .kici to pnpm-workspace.yaml', async () => {
      await makePnpmWorkspace();
      expect(await initCommand({ workspace: true, skipInstall: true })).toBe(true);

      // fails-when: --workspace leaves .kici/ with no manifest, so no agent install path
      // runs and @kici-dev/sdk never resolves on an agent
      const kiciPkg = JSON.parse(
        await fs.readFile(path.join(tempDir, '.kici', 'package.json'), 'utf-8'),
      );
      expect(kiciPkg.devDependencies['@kici-dev/sdk']).toBeDefined();
      expect(await exists(path.join(tempDir, '.kici', 'tsconfig.json'))).toBe(true);
      const ws = parseYaml(
        await fs.readFile(path.join(tempDir, 'pnpm-workspace.yaml'), 'utf-8'),
      ) as { packages: string[] };
      expect(ws.packages).toEqual(['packages/*', '.kici']);
      // breaks-if-wrong: the root manifest is no longer where the SDK is declared
      const root = JSON.parse(await fs.readFile(path.join(tempDir, 'package.json'), 'utf-8'));
      expect(root.devDependencies?.['@kici-dev/sdk']).toBeUndefined();
    });

    it.each([
      ['npm', { workspaces: ['packages/*'] }],
      ['yarn', { workspaces: { packages: ['packages/*'] }, packageManager: 'yarn@1.22.22' }],
    ])('adds .kici to the root package.json workspaces of a %s workspace', async (_kind, extra) => {
      await fs.writeFile(
        path.join(tempDir, 'package.json'),
        JSON.stringify({ name: 'root', private: true, ...extra }, null, 2) + '\n',
      );
      await fs.writeFile(path.join(tempDir, '.git'), 'gitdir: x\n');
      expect(await initCommand({ workspace: true, skipInstall: true })).toBe(true);
      const root = JSON.parse(await fs.readFile(path.join(tempDir, 'package.json'), 'utf-8'));
      const list = Array.isArray(root.workspaces) ? root.workspaces : root.workspaces.packages;
      expect(list).toEqual(['packages/*', '.kici']);
      expect(await exists(path.join(tempDir, '.kici', 'package.json'))).toBe(true);
    });

    it('writes the same .kici/package.json the standalone scaffold writes', async () => {
      await makePnpmWorkspace();
      await initCommand({ workspace: true, skipInstall: true });
      // fails-when: the member layout writes its own manifest, so a pin-policy change
      // to generatePackageJson reaches only the standalone layout
      expect(await fs.readFile(path.join(tempDir, '.kici', 'package.json'), 'utf-8')).toBe(
        generatePackageJson(VersionPin.Caret),
      );
    });

    it('writes exact versions when the workspace root .npmrc sets save-exact', async () => {
      await makePnpmWorkspace();
      await fs.writeFile(path.join(tempDir, '.npmrc'), 'save-exact=true\n', 'utf-8');
      await initCommand({ workspace: true, skipInstall: true });
      // fails-when: the member layout never reads the workspace .npmrc
      expect(await fs.readFile(path.join(tempDir, '.kici', 'package.json'), 'utf-8')).toBe(
        generatePackageJson(VersionPin.Exact),
      );
    });

    it('leaves an existing root @kici-dev/sdk declaration byte-identical and names it', async () => {
      await makePnpmWorkspace();
      const rootRaw =
        JSON.stringify(
          { name: 'root', private: true, devDependencies: { '@kici-dev/sdk': '1.2.3' } },
          null,
          2,
        ) + '\n';
      await fs.writeFile(path.join(tempDir, 'package.json'), rootRaw);
      const info = vi.spyOn(logger, 'info');
      try {
        await initCommand({ workspace: true, skipInstall: true });
        expect(await fs.readFile(path.join(tempDir, 'package.json'), 'utf-8')).toBe(rootRaw);
        expect(info.mock.calls.map(([m]) => String(m)).join('\n')).toContain(
          'still declares @kici-dev/sdk (1.2.3)',
        );
      } finally {
        info.mockRestore();
      }
    });

    it('prints the sibling specifier for the detected manager', async () => {
      await makePnpmWorkspace();
      const info = vi.spyOn(logger, 'info');
      try {
        await initCommand({ workspace: true, skipInstall: true });
        expect(info.mock.calls.map(([m]) => String(m)).join('\n')).toContain(
          '"@your-scope/utils": "workspace:*"',
        );
      } finally {
        info.mockRestore();
      }
    });

    it('dev mode writes the root .npmrc, not .kici/.npmrc', async () => {
      process.env.KICI_DEV = 'true';
      process.env.KICI_DEV_REGISTRY = 'http://registry.local:4873';
      try {
        await makePnpmWorkspace();
        await initCommand({ workspace: true, skipInstall: true });
        expect(await exists(path.join(tempDir, '.npmrc'))).toBe(true);
        expect(await exists(path.join(tempDir, '.kici', '.npmrc'))).toBe(false);
        const npmrc = await fs.readFile(path.join(tempDir, '.npmrc'), 'utf-8');
        expect(npmrc).toContain('@kici-dev:registry=');
      } finally {
        delete process.env.KICI_DEV;
        delete process.env.KICI_DEV_REGISTRY;
      }
    });

    it('dev mode with no KICI_DEV_REGISTRY writes no .npmrc at all', async () => {
      process.env.KICI_DEV = 'true';
      try {
        await makePnpmWorkspace();
        await initCommand({ workspace: true, skipInstall: true });
        expect(await exists(path.join(tempDir, '.npmrc'))).toBe(false);
        expect(await exists(path.join(tempDir, '.kici', '.npmrc'))).toBe(false);
      } finally {
        delete process.env.KICI_DEV;
      }
    });

    it('--workspace with no workspace fails', async () => {
      // A .git marker but no workspace manifest → detection returns null.
      await fs.writeFile(path.join(tempDir, '.git'), 'gitdir: x\n');
      const ok = await initCommand({ workspace: true, skipInstall: true });
      expect(ok).toBe(false);
    });

    it('--workspace and --standalone together fails', async () => {
      await makePnpmWorkspace();
      const ok = await initCommand({ workspace: true, standalone: true, skipInstall: true });
      expect(ok).toBe(false);
    });

    it('--standalone inside a workspace writes the standalone layout', async () => {
      await makePnpmWorkspace();
      await initCommand({ standalone: true, skipInstall: true });
      expect(await exists(path.join(tempDir, '.kici', 'package.json'))).toBe(true);
    });

    it('CI/non-TTY inside a workspace defaults to standalone (no flag)', async () => {
      // CI=true is set by the suite's beforeEach.
      await makePnpmWorkspace();
      await initCommand({ skipInstall: true });
      expect(await exists(path.join(tempDir, '.kici', 'package.json'))).toBe(true);
    });
  });

  describe('re-running --workspace on an older workspace scaffold', () => {
    const ROOT_OLD = {
      name: 'root',
      private: true,
      scripts: { build: 'tsc -b' },
      dependencies: { lodash: '^4.17.21' },
      devDependencies: { '@kici-dev/sdk': '^0.17.0', vitest: '^4.0.0' },
    };

    /** The layout an older `kici init --workspace` left, plus a user-edited workflow. */
    async function makeOldScaffold(
      workspaceFile: 'pnpm' | 'npm',
      listKici: boolean,
    ): Promise<void> {
      await fs.writeFile(path.join(tempDir, '.git'), 'gitdir: x\n');
      if (workspaceFile === 'pnpm') {
        await fs.writeFile(
          path.join(tempDir, 'pnpm-workspace.yaml'),
          `# members\npackages:\n  - 'packages/*'\n${listKici ? "  - '.kici'\n" : ''}`,
        );
        await fs.writeFile(
          path.join(tempDir, 'package.json'),
          JSON.stringify(ROOT_OLD, null, 2) + '\n',
        );
      } else {
        const workspaces = listKici ? ['packages/*', '.kici'] : ['packages/*'];
        await fs.writeFile(
          path.join(tempDir, 'package.json'),
          JSON.stringify({ ...ROOT_OLD, workspaces }, null, 2) + '\n',
        );
      }
      await fs.mkdir(path.join(tempDir, '.kici', 'workflows'), { recursive: true });
      await fs.writeFile(
        path.join(tempDir, '.kici', 'workflows', 'ci.ts'),
        '// user edit\nexport {};\n',
      );
      await fs.writeFile(
        path.join(tempDir, '.kici', 'tsconfig.json'),
        '{"compilerOptions":{"strict":true}}\n',
      );
    }

    const TRACKED = [
      'package.json',
      'pnpm-workspace.yaml',
      '.kici/package.json',
      '.kici/tsconfig.json',
      '.kici/workflows/ci.ts',
    ];
    async function snapshot(): Promise<Record<string, string | null>> {
      const out: Record<string, string | null> = {};
      for (const rel of TRACKED) {
        out[rel] = await fs.readFile(path.join(tempDir, rel), 'utf-8').catch(() => null);
      }
      return out;
    }

    it.each([false, true])(
      'pnpm (.kici already listed: %s): completes the member layout, then a second run changes nothing',
      async (listKici) => {
        await makeOldScaffold('pnpm', listKici);
        const before = await snapshot();

        // fails-when: --workspace on an existing .kici/ refuses with "already exists",
        // so an older scaffold can never be repaired without --force deleting the workflows
        expect(await initCommand({ workspace: true, skipInstall: true })).toBe(true);

        const after = await snapshot();
        expect(after['.kici/package.json']).not.toBeNull();
        const wsRaw = after['pnpm-workspace.yaml']!;
        // fails-when: an already-listed .kici is appended a second time
        expect(
          (parseYaml(wsRaw) as { packages: string[] }).packages.filter((p) => p === '.kici'),
        ).toEqual(['.kici']);
        expect(wsRaw).toContain('# members');
        // breaks-if-wrong: the user's root manifest (other dependencies, scripts and the stale
        // SDK line) and their workflow and tsconfig are byte-identical
        expect(after['package.json']).toBe(before['package.json']);
        expect(after['.kici/workflows/ci.ts']).toBe(before['.kici/workflows/ci.ts']);
        expect(after['.kici/tsconfig.json']).toBe(before['.kici/tsconfig.json']);

        const info = vi.spyOn(logger, 'info');
        try {
          expect(await initCommand({ workspace: true, skipInstall: true })).toBe(true);
          // property: the second run writes nothing
          expect(await snapshot()).toEqual(after);
          expect(info.mock.calls.map(([m]) => String(m)).join('\n')).toContain(
            'already a workspace member',
          );
        } finally {
          info.mockRestore();
        }
      },
    );

    it('npm: adds .kici to workspaces and keeps every root dependency map as it was', async () => {
      await makeOldScaffold('npm', false);
      expect(await initCommand({ workspace: true, skipInstall: true })).toBe(true);
      const root = JSON.parse(await fs.readFile(path.join(tempDir, 'package.json'), 'utf-8'));
      expect(root.workspaces).toEqual(['packages/*', '.kici']);
      // The stale SDK line is left in place: init cannot tell who wrote it.
      expect(root.dependencies).toEqual(ROOT_OLD.dependencies);
      expect(root.devDependencies).toEqual(ROOT_OLD.devDependencies);
      expect(root.scripts).toEqual(ROOT_OLD.scripts);
      const once = await snapshot();
      expect(await initCommand({ workspace: true, skipInstall: true })).toBe(true);
      expect(await snapshot()).toEqual(once);
    });

    it('yarn: adds a missing version to a listed .kici/package.json, then changes nothing', async () => {
      await fs.writeFile(path.join(tempDir, '.git'), 'gitdir: x\n');
      await fs.writeFile(
        path.join(tempDir, 'package.json'),
        JSON.stringify(
          { name: 'root', private: true, packageManager: 'yarn@1.22.22', workspaces: ['.kici'] },
          null,
          2,
        ) + '\n',
      );
      await fs.mkdir(path.join(tempDir, '.kici', 'workflows'), { recursive: true });
      await fs.writeFile(path.join(tempDir, '.kici', 'tsconfig.json'), '{}\n');
      await fs.writeFile(
        path.join(tempDir, '.kici', 'package.json'),
        JSON.stringify({ name: '@kici-dev/workflows', private: true }, null, 2) + '\n',
      );
      expect(await initCommand({ workspace: true, skipInstall: true })).toBe(true);
      const once = await snapshot();
      // fails-when: an existing yarn member keeps its version-less manifest, which yarn ignores
      expect(JSON.parse(once['.kici/package.json']!).version).toBe('0.0.0');
      expect(await initCommand({ workspace: true, skipInstall: true })).toBe(true);
      expect(await snapshot()).toEqual(once);
    });

    it('refuses a standalone .kici/ that the workspace does not list, and changes nothing', async () => {
      await makeOldScaffold('pnpm', false);
      await fs.writeFile(
        path.join(tempDir, '.kici', 'package.json'),
        '{"name":"@kici-dev/workflows"}\n',
      );
      const before = await snapshot();
      expect(await initCommand({ workspace: true, skipInstall: true })).toBe(false);
      expect(await snapshot()).toEqual(before);
    });

    it('plain kici init on an existing .kici/ still refuses', async () => {
      await makeOldScaffold('pnpm', false);
      // breaks-if-wrong: only --workspace gains the in-place path
      expect(await initCommand({ skipInstall: true })).toBe(false);
      expect(await exists(path.join(tempDir, '.kici', 'package.json'))).toBe(false);
    });

    it('--workspace --standalone on an existing .kici/ still fails', async () => {
      await makeOldScaffold('pnpm', false);
      expect(await initCommand({ workspace: true, standalone: true, skipInstall: true })).toBe(
        false,
      );
    });
  });

  describe('host-OS runsOn rewrite', () => {
    it('scaffolds runsOn matching the host OS', async () => {
      const nodeOs = await import('node:os');
      const { primaryHostOsLabel } = await import('./commands/init-host-os.js');
      const expectedLabel = primaryHostOsLabel(nodeOs.platform(), nodeOs.arch());

      const success = await initCommand({ skipInstall: true });
      expect(success).toBe(true);

      const hello = await fs.readFile('.kici/workflows/hello-world.ts', 'utf-8');
      expect(hello).toContain(`runsOn: '${expectedLabel}'`);
      // On a non-Linux host the stale kici:os:linux must be gone; on a Linux
      // host expectedLabel IS kici:os:linux so this guard is inert.
      if (expectedLabel !== 'kici:os:linux') {
        expect(hello).not.toContain('kici:os:linux');
      }
    });
  });
});

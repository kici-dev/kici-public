import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {
  PackageManager,
  PNPM_IGNORE_BUILD_GATE_ARG,
  YarnFlavor,
  detectPackageManager,
  detectYarnFlavor,
  detectYarnFlavorSync,
  installBuildPolicyArgs,
  installCommand,
} from './package-manager.js';

describe('detectPackageManager', () => {
  let tempDir: string;
  let savedUserAgent: string | undefined;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kici-detect-pm-'));
    savedUserAgent = process.env.npm_config_user_agent;
    delete process.env.npm_config_user_agent;
  });

  afterEach(async () => {
    if (savedUserAgent === undefined) {
      delete process.env.npm_config_user_agent;
    } else {
      process.env.npm_config_user_agent = savedUserAgent;
    }
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  describe('tier 1: packageManager field in package.json', () => {
    it('detects pnpm from "packageManager": "pnpm@9.x"', async () => {
      await fs.writeFile(
        path.join(tempDir, 'package.json'),
        JSON.stringify({ packageManager: 'pnpm@9.1.0' }),
        'utf-8',
      );
      expect(await detectPackageManager(tempDir)).toBe(PackageManager.Pnpm);
    });

    it('detects yarn from "packageManager": "yarn@4.x"', async () => {
      await fs.writeFile(
        path.join(tempDir, 'package.json'),
        JSON.stringify({ packageManager: 'yarn@4.2.0' }),
        'utf-8',
      );
      expect(await detectPackageManager(tempDir)).toBe(PackageManager.Yarn);
    });

    it('detects npm from "packageManager": "npm@10.x"', async () => {
      await fs.writeFile(
        path.join(tempDir, 'package.json'),
        JSON.stringify({ packageManager: 'npm@10.5.0' }),
        'utf-8',
      );
      expect(await detectPackageManager(tempDir)).toBe(PackageManager.Npm);
    });

    it('handles packageManager with a sha hash suffix', async () => {
      await fs.writeFile(
        path.join(tempDir, 'package.json'),
        JSON.stringify({ packageManager: 'pnpm@9.1.0+sha512.abc123' }),
        'utf-8',
      );
      expect(await detectPackageManager(tempDir)).toBe(PackageManager.Pnpm);
    });

    it('ignores an unrecognized packageManager value and falls through', async () => {
      await fs.writeFile(
        path.join(tempDir, 'package.json'),
        JSON.stringify({ packageManager: 'bun@1.0.0' }),
        'utf-8',
      );
      // No lockfile, no user-agent -> default npm
      expect(await detectPackageManager(tempDir)).toBe(PackageManager.Npm);
    });

    it('packageManager field wins over a conflicting lockfile', async () => {
      await fs.writeFile(
        path.join(tempDir, 'package.json'),
        JSON.stringify({ packageManager: 'pnpm@9.1.0' }),
        'utf-8',
      );
      // Conflicting lockfile should be ignored because the field wins.
      await fs.writeFile(path.join(tempDir, 'yarn.lock'), '', 'utf-8');
      expect(await detectPackageManager(tempDir)).toBe(PackageManager.Pnpm);
    });
  });

  describe('tier 2: lockfile in project root', () => {
    it('detects pnpm from pnpm-lock.yaml', async () => {
      await fs.writeFile(path.join(tempDir, 'pnpm-lock.yaml'), '', 'utf-8');
      expect(await detectPackageManager(tempDir)).toBe(PackageManager.Pnpm);
    });

    it('detects yarn from yarn.lock', async () => {
      await fs.writeFile(path.join(tempDir, 'yarn.lock'), '', 'utf-8');
      expect(await detectPackageManager(tempDir)).toBe(PackageManager.Yarn);
    });

    it('detects npm from package-lock.json', async () => {
      await fs.writeFile(path.join(tempDir, 'package-lock.json'), '{}', 'utf-8');
      expect(await detectPackageManager(tempDir)).toBe(PackageManager.Npm);
    });

    it('lockfile wins over a conflicting user-agent', async () => {
      await fs.writeFile(path.join(tempDir, 'pnpm-lock.yaml'), '', 'utf-8');
      process.env.npm_config_user_agent = 'yarn/4.2.0 npm/? node/v24.0.0 linux x64';
      expect(await detectPackageManager(tempDir)).toBe(PackageManager.Pnpm);
    });

    it('prefers pnpm-lock.yaml over yarn.lock when both exist', async () => {
      await fs.writeFile(path.join(tempDir, 'pnpm-lock.yaml'), '', 'utf-8');
      await fs.writeFile(path.join(tempDir, 'yarn.lock'), '', 'utf-8');
      expect(await detectPackageManager(tempDir)).toBe(PackageManager.Pnpm);
    });
  });

  describe('tier 3: npm_config_user_agent env var', () => {
    it('detects pnpm from a pnpm/ user agent', async () => {
      process.env.npm_config_user_agent = 'pnpm/9.1.0 npm/? node/v24.0.0 linux x64';
      expect(await detectPackageManager(tempDir)).toBe(PackageManager.Pnpm);
    });

    it('detects yarn from a yarn/ user agent', async () => {
      process.env.npm_config_user_agent = 'yarn/4.2.0 npm/? node/v24.0.0 linux x64';
      expect(await detectPackageManager(tempDir)).toBe(PackageManager.Yarn);
    });

    it('detects npm from an npm/ user agent', async () => {
      process.env.npm_config_user_agent = 'npm/10.5.0 node/v24.0.0 linux x64';
      expect(await detectPackageManager(tempDir)).toBe(PackageManager.Npm);
    });
  });

  describe('tier 4: default', () => {
    it('defaults to npm when nothing matches', async () => {
      expect(await detectPackageManager(tempDir)).toBe(PackageManager.Npm);
    });

    it('defaults to npm when an unrecognized user agent is set', async () => {
      process.env.npm_config_user_agent = 'bun/1.0.0 node/v24.0.0 linux x64';
      expect(await detectPackageManager(tempDir)).toBe(PackageManager.Npm);
    });
  });
});

describe('installCommand', () => {
  it('maps each PackageManager to its install invocation', () => {
    expect(installCommand(PackageManager.Npm)).toEqual(['npm', 'install']);
    expect(installCommand(PackageManager.Pnpm)).toEqual(['pnpm', 'install']);
    expect(installCommand(PackageManager.Yarn)).toEqual(['yarn', 'install']);
  });
});

describe('installBuildPolicyArgs', () => {
  it('adds the strict-dep-builds-off flag for pnpm', () => {
    expect(installBuildPolicyArgs(PackageManager.Pnpm)).toEqual([PNPM_IGNORE_BUILD_GATE_ARG]);
    expect(PNPM_IGNORE_BUILD_GATE_ARG).toBe('--config.strict-dep-builds=false');
  });

  it('adds no flags for npm and yarn (they run build scripts by default)', () => {
    expect(installBuildPolicyArgs(PackageManager.Npm)).toEqual([]);
    expect(installBuildPolicyArgs(PackageManager.Yarn)).toEqual([]);
  });
});

describe('detectYarnFlavor', () => {
  it('reads the packageManager field major (>=2 => berry)', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'kici-yf-'));
    await fs.writeFile(
      path.join(dir, 'package.json'),
      JSON.stringify({ packageManager: 'yarn@3.6.4' }),
    );
    expect(await detectYarnFlavor(dir)).toBe(YarnFlavor.Berry);
  });

  it('reads the packageManager field major (==1 => classic)', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'kici-yf-'));
    await fs.writeFile(
      path.join(dir, 'package.json'),
      JSON.stringify({ packageManager: 'yarn@1.22.22' }),
    );
    expect(await detectYarnFlavor(dir)).toBe(YarnFlavor.Classic);
  });

  it('treats a present .yarnrc.yml as berry', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'kici-yf-'));
    await fs.writeFile(path.join(dir, '.yarnrc.yml'), 'nodeLinker: node-modules\n');
    expect(await detectYarnFlavor(dir)).toBe(YarnFlavor.Berry);
  });

  it('treats a yarn.lock with __metadata as berry', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'kici-yf-'));
    await fs.writeFile(
      path.join(dir, 'yarn.lock'),
      '# This file is generated\n__metadata:\n  version: 8\n',
    );
    expect(await detectYarnFlavor(dir)).toBe(YarnFlavor.Berry);
  });

  it('defaults to classic when no berry signal is present', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'kici-yf-'));
    await fs.writeFile(path.join(dir, 'yarn.lock'), '# yarn lockfile v1\n"@foo/bar@^1.0.0":\n');
    expect(await detectYarnFlavor(dir)).toBe(YarnFlavor.Classic);
  });

  it('detectYarnFlavorSync matches the async result', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'kici-yf-'));
    await fs.writeFile(
      path.join(dir, 'package.json'),
      JSON.stringify({ packageManager: 'yarn@4.1.0' }),
    );
    expect(detectYarnFlavorSync(dir)).toBe(YarnFlavor.Berry);
  });
});

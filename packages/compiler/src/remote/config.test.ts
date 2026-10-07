import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

// Mock os.homedir to isolate tests from real home directory
vi.mock('node:os', async () => {
  const actual = await vi.importActual<typeof import('node:os')>('node:os');
  return {
    ...actual,
    default: {
      ...actual,
      homedir: vi.fn(),
    },
  };
});

import {
  getConfigDir,
  getConfigPath,
  loadGlobalConfig,
  saveGlobalConfig,
  mergeGlobalConfig,
} from './config.js';

describe('global config management', () => {
  let tempDir: string;
  let harnessConfigDir: string | undefined;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kici-config-test-'));
    vi.mocked(os.homedir).mockReturnValue(tempDir);
    // The vitest harness sets KICI_CONFIG_DIR to an isolated tempdir so the CLI
    // never reads the developer's ambient ~/.kici. Save it, and repoint it at
    // exactly the directory the mocked homedir produces, so the file-writing
    // cases below read and write inside this test's temp dir.
    harnessConfigDir = process.env.KICI_CONFIG_DIR;
    process.env.KICI_CONFIG_DIR = path.join(tempDir, '.kici');
  });

  afterEach(async () => {
    // Restore the harness's isolated dir rather than deleting it, so a later
    // test file reusing this worker keeps its isolation from the ambient
    // ~/.kici config.
    if (harnessConfigDir === undefined) delete process.env.KICI_CONFIG_DIR;
    else process.env.KICI_CONFIG_DIR = harnessConfigDir;
    vi.restoreAllMocks();
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  describe('getConfigDir', () => {
    it('returns ~/.kici path', () => {
      const dir = getConfigDir({});
      expect(dir).toBe(path.join(tempDir, '.kici'));
    });

    it('returns KICI_CONFIG_DIR when env var is set', () => {
      const dir = getConfigDir({ KICI_CONFIG_DIR: '/tmp/custom-kici-config' });
      expect(dir).toBe('/tmp/custom-kici-config');
    });

    it('ignores KICI_CONFIG_DIR when empty string', () => {
      // An empty string is falsy, so it falls through to the homedir default
      // rather than resolving to an empty path. Deliberate — do not "fix".
      const dir = getConfigDir({ KICI_CONFIG_DIR: '' });
      expect(dir).toBe(path.join(tempDir, '.kici'));
    });

    it('returns KICI_CONFIG_DIR when set, else ~/.kici (no test-isolation branch)', () => {
      expect(getConfigDir({ KICI_CONFIG_DIR: '/tmp/iso' })).toBe('/tmp/iso');
      expect(getConfigDir({})).toBe(path.join(tempDir, '.kici'));
    });

    it('ignores unrelated env vars and resolves the homedir default', () => {
      // Only KICI_CONFIG_DIR affects resolution; any other key (including the
      // runner's own VITEST marker) falls through to ~/.kici. `kici` is a
      // compat-protected CLI, so a customer whose vitest test shells out to it
      // must resolve the ordinary default.
      expect(getConfigDir({ VITEST: 'true' })).toBe(path.join(tempDir, '.kici'));
      expect(getConfigDir({ NODE_ENV: 'production' })).toBe(path.join(tempDir, '.kici'));
    });
  });

  describe('getConfigPath', () => {
    it('returns ~/.kici/config path', () => {
      const configPath = getConfigPath();
      expect(configPath).toBe(path.join(tempDir, '.kici', 'config'));
    });
  });

  describe('loadGlobalConfig', () => {
    it('returns empty object when file does not exist', async () => {
      const config = await loadGlobalConfig();
      expect(config).toEqual({});
    });

    it('loads valid config from file', async () => {
      const kiciDir = path.join(tempDir, '.kici');
      await fs.mkdir(kiciDir, { recursive: true });
      await fs.writeFile(
        path.join(kiciDir, 'config'),
        JSON.stringify({
          pat: 'test-token-123',
          endpoint: 'https://orchestrator.example.com',
          routingKey: 'github:42',
        }),
      );

      const config = await loadGlobalConfig();
      expect(config.pat).toBe('test-token-123');
      expect(config.endpoint).toBe('https://orchestrator.example.com');
      expect(config.routingKey).toBe('github:42');
    });

    it('strips unknown keys from config', async () => {
      const kiciDir = path.join(tempDir, '.kici');
      await fs.mkdir(kiciDir, { recursive: true });
      await fs.writeFile(
        path.join(kiciDir, 'config'),
        JSON.stringify({
          pat: 'valid-token',
          unknownKey: 'should-be-stripped',
          anotherUnknown: 42,
        }),
      );

      const config = await loadGlobalConfig();
      expect(config).toEqual({ pat: 'valid-token' });
      expect((config as Record<string, unknown>).unknownKey).toBeUndefined();
    });

    it('drops a token key, so only a PAT authenticates', async () => {
      const kiciDir = path.join(tempDir, '.kici');
      await fs.mkdir(kiciDir, { recursive: true });
      await fs.writeFile(
        path.join(kiciDir, 'config'),
        JSON.stringify({ endpoint: 'https://api.kici.dev', token: 'kici_old', pat: 'kici_pat_x' }),
      );

      const config = await loadGlobalConfig();
      // fails-when: sanitizeConfig still copies `token` — a stale API key would authenticate.
      expect((config as Record<string, unknown>).token).toBeUndefined();
      // breaks-if-wrong: the PAT next to it must still load.
      expect(config.pat).toBe('kici_pat_x');
    });

    it('round-trips defaultClusters and drops non-string values', async () => {
      const kiciDir = path.join(tempDir, '.kici');
      await fs.mkdir(kiciDir, { recursive: true });
      await fs.writeFile(
        path.join(kiciDir, 'config'),
        JSON.stringify({
          pat: 'tok',
          defaultClusters: { org_a: 'cluster-1', org_b: 'cluster-2', org_bad: 42 },
        }),
      );

      const config = await loadGlobalConfig();
      expect(config.defaultClusters).toEqual({ org_a: 'cluster-1', org_b: 'cluster-2' });
    });

    it('drops defaultClusters entirely when it is not an object', async () => {
      const kiciDir = path.join(tempDir, '.kici');
      await fs.mkdir(kiciDir, { recursive: true });
      await fs.writeFile(
        path.join(kiciDir, 'config'),
        JSON.stringify({ pat: 'tok', defaultClusters: ['not', 'an', 'object'] }),
      );

      const config = await loadGlobalConfig();
      expect(config.defaultClusters).toBeUndefined();
    });

    it('keeps a valid oidcIssuer string', async () => {
      const kiciDir = path.join(tempDir, '.kici');
      await fs.mkdir(kiciDir, { recursive: true });
      await fs.writeFile(
        path.join(kiciDir, 'config'),
        JSON.stringify({ oidcIssuer: 'https://auth.example.com/realms/kici-internal' }),
        { mode: 0o600 },
      );

      const config = await loadGlobalConfig();
      expect(config.oidcIssuer).toBe('https://auth.example.com/realms/kici-internal');
    });

    it('drops a non-string oidcIssuer', async () => {
      const kiciDir = path.join(tempDir, '.kici');
      await fs.mkdir(kiciDir, { recursive: true });
      await fs.writeFile(path.join(kiciDir, 'config'), JSON.stringify({ oidcIssuer: 12345 }), {
        mode: 0o600,
      });

      const config = await loadGlobalConfig();
      expect(config.oidcIssuer).toBeUndefined();
    });

    it('throws a helpful error on corrupted JSON', async () => {
      const kiciDir = path.join(tempDir, '.kici');
      await fs.mkdir(kiciDir, { recursive: true });
      await fs.writeFile(path.join(kiciDir, 'config'), 'not valid json {{{');

      await expect(loadGlobalConfig()).rejects.toThrow(/contains invalid JSON/);
      await expect(loadGlobalConfig()).rejects.toThrow(/kici login/);
    });
  });

  describe('saveGlobalConfig', () => {
    it('creates config file with correct content', async () => {
      const config = {
        pat: 'my-api-key',
        endpoint: 'https://orch.example.com',
        routingKey: 'github:42',
      };

      await saveGlobalConfig(config);

      const configPath = path.join(tempDir, '.kici', 'config');
      const content = await fs.readFile(configPath, 'utf-8');
      const parsed = JSON.parse(content);

      expect(parsed.pat).toBe('my-api-key');
      expect(parsed.endpoint).toBe('https://orch.example.com');
      expect(parsed.routingKey).toBe('github:42');
    });

    it('creates directory if it does not exist', async () => {
      await saveGlobalConfig({ pat: 'test' });

      const kiciDir = path.join(tempDir, '.kici');
      const stat = await fs.stat(kiciDir);
      expect(stat.isDirectory()).toBe(true);
    });

    it('sets file permissions to 0o600', async () => {
      await saveGlobalConfig({ pat: 'secret-token' });

      const configPath = path.join(tempDir, '.kici', 'config');
      const stat = await fs.stat(configPath);
      // 0o600 = owner read/write only (octal 33152 with file type bits, mode is 0o100600)
      const mode = stat.mode & 0o777;
      expect(mode).toBe(0o600);
    });

    it('writes valid JSON with 2-space indent', async () => {
      await saveGlobalConfig({ pat: 'test', endpoint: 'https://example.com' });

      const configPath = path.join(tempDir, '.kici', 'config');
      const content = await fs.readFile(configPath, 'utf-8');

      // Should be formatted with 2-space indent
      expect(content).toContain('  "pat"');
      expect(content).toContain('  "endpoint"');
      // Should end with newline
      expect(content.endsWith('\n')).toBe(true);
      // Should be valid JSON
      expect(() => JSON.parse(content)).not.toThrow();
    });
  });

  describe('mergeGlobalConfig', () => {
    it('preserves existing keys while adding new ones', async () => {
      // Save initial config
      await saveGlobalConfig({
        pat: 'existing-token',
        endpoint: 'https://existing.example.com',
      });

      // Merge new platformEndpoint
      const merged = await mergeGlobalConfig({
        platformEndpoint: 'https://platform.example.com',
      });

      expect(merged.pat).toBe('existing-token');
      expect(merged.endpoint).toBe('https://existing.example.com');
      expect(merged.platformEndpoint).toBe('https://platform.example.com');
    });

    it('overwrites existing keys with new values', async () => {
      await saveGlobalConfig({ pat: 'old-token' });

      const merged = await mergeGlobalConfig({ pat: 'new-token' });

      expect(merged.pat).toBe('new-token');
    });

    it('returns merged config and persists it', async () => {
      await saveGlobalConfig({ pat: 'first' });
      await mergeGlobalConfig({ endpoint: 'https://orch.example.com' });

      // Reload from disk to verify persistence
      const reloaded = await loadGlobalConfig();
      expect(reloaded.pat).toBe('first');
      expect(reloaded.endpoint).toBe('https://orch.example.com');
    });

    it('creates config from scratch when no file exists', async () => {
      const merged = await mergeGlobalConfig({
        pat: 'brand-new',
        routingKey: 'github:42',
      });

      expect(merged.pat).toBe('brand-new');
      expect(merged.routingKey).toBe('github:42');
    });

    it('persists and merges defaultClusters', async () => {
      await saveGlobalConfig({ pat: 'p', defaultClusters: { org_a: 'cluster-1' } });

      const merged = await mergeGlobalConfig({
        defaultClusters: { org_a: 'cluster-1', org_b: 'cluster-2' },
      });

      expect(merged.defaultClusters).toEqual({ org_a: 'cluster-1', org_b: 'cluster-2' });
      const reloaded = await loadGlobalConfig();
      expect(reloaded.defaultClusters).toEqual({ org_a: 'cluster-1', org_b: 'cluster-2' });
    });

    it('ignores undefined values in partial', async () => {
      await saveGlobalConfig({ pat: 'keep-me', endpoint: 'https://keep.example.com' });

      const merged = await mergeGlobalConfig({ pat: undefined });

      expect(merged.pat).toBe('keep-me');
      expect(merged.endpoint).toBe('https://keep.example.com');
    });
  });

  describe('KICI_CONFIG_DIR env var integration', () => {
    let customConfigDir: string;

    beforeEach(async () => {
      customConfigDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kici-custom-config-'));
      process.env.KICI_CONFIG_DIR = customConfigDir;
    });

    afterEach(async () => {
      delete process.env.KICI_CONFIG_DIR;
      await fs.rm(customConfigDir, { recursive: true, force: true });
    });

    it('saveGlobalConfig writes to custom config dir', async () => {
      await saveGlobalConfig({ pat: 'custom-dir-token' });

      const configPath = path.join(customConfigDir, 'config');
      const content = await fs.readFile(configPath, 'utf-8');
      const parsed = JSON.parse(content);
      expect(parsed.pat).toBe('custom-dir-token');
    });

    it('loadGlobalConfig reads from custom config dir', async () => {
      await fs.writeFile(
        path.join(customConfigDir, 'config'),
        JSON.stringify({ pat: 'from-custom-dir' }),
        { mode: 0o600 },
      );

      const config = await loadGlobalConfig();
      expect(config.pat).toBe('from-custom-dir');
    });
  });
});

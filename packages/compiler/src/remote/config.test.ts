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

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kici-config-test-'));
    vi.mocked(os.homedir).mockReturnValue(tempDir);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  describe('getConfigDir', () => {
    it('returns ~/.kici path', () => {
      const dir = getConfigDir();
      expect(dir).toBe(path.join(tempDir, '.kici'));
    });

    it('returns KICI_CONFIG_DIR when env var is set', () => {
      const customDir = '/tmp/custom-kici-config';
      process.env.KICI_CONFIG_DIR = customDir;
      try {
        const dir = getConfigDir();
        expect(dir).toBe(customDir);
      } finally {
        delete process.env.KICI_CONFIG_DIR;
      }
    });

    it('ignores KICI_CONFIG_DIR when empty string', () => {
      process.env.KICI_CONFIG_DIR = '';
      try {
        const dir = getConfigDir();
        expect(dir).toBe(path.join(tempDir, '.kici'));
      } finally {
        delete process.env.KICI_CONFIG_DIR;
      }
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
          token: 'test-token-123',
          endpoint: 'https://orchestrator.example.com',
          routingKey: 'github:42',
        }),
      );

      const config = await loadGlobalConfig();
      expect(config.token).toBe('test-token-123');
      expect(config.endpoint).toBe('https://orchestrator.example.com');
      expect(config.routingKey).toBe('github:42');
    });

    it('strips unknown keys from config', async () => {
      const kiciDir = path.join(tempDir, '.kici');
      await fs.mkdir(kiciDir, { recursive: true });
      await fs.writeFile(
        path.join(kiciDir, 'config'),
        JSON.stringify({
          token: 'valid-token',
          unknownKey: 'should-be-stripped',
          anotherUnknown: 42,
        }),
      );

      const config = await loadGlobalConfig();
      expect(config).toEqual({ token: 'valid-token' });
      expect((config as Record<string, unknown>).unknownKey).toBeUndefined();
    });

    it('round-trips defaultClusters and drops non-string values', async () => {
      const kiciDir = path.join(tempDir, '.kici');
      await fs.mkdir(kiciDir, { recursive: true });
      await fs.writeFile(
        path.join(kiciDir, 'config'),
        JSON.stringify({
          token: 'tok',
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
        JSON.stringify({ token: 'tok', defaultClusters: ['not', 'an', 'object'] }),
      );

      const config = await loadGlobalConfig();
      expect(config.defaultClusters).toBeUndefined();
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
        token: 'my-api-key',
        endpoint: 'https://orch.example.com',
        routingKey: 'github:42',
      };

      await saveGlobalConfig(config);

      const configPath = path.join(tempDir, '.kici', 'config');
      const content = await fs.readFile(configPath, 'utf-8');
      const parsed = JSON.parse(content);

      expect(parsed.token).toBe('my-api-key');
      expect(parsed.endpoint).toBe('https://orch.example.com');
      expect(parsed.routingKey).toBe('github:42');
    });

    it('creates directory if it does not exist', async () => {
      await saveGlobalConfig({ token: 'test' });

      const kiciDir = path.join(tempDir, '.kici');
      const stat = await fs.stat(kiciDir);
      expect(stat.isDirectory()).toBe(true);
    });

    it('sets file permissions to 0o600', async () => {
      await saveGlobalConfig({ token: 'secret-token' });

      const configPath = path.join(tempDir, '.kici', 'config');
      const stat = await fs.stat(configPath);
      // 0o600 = owner read/write only (octal 33152 with file type bits, mode is 0o100600)
      const mode = stat.mode & 0o777;
      expect(mode).toBe(0o600);
    });

    it('writes valid JSON with 2-space indent', async () => {
      await saveGlobalConfig({ token: 'test', endpoint: 'https://example.com' });

      const configPath = path.join(tempDir, '.kici', 'config');
      const content = await fs.readFile(configPath, 'utf-8');

      // Should be formatted with 2-space indent
      expect(content).toContain('  "token"');
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
        token: 'existing-token',
        endpoint: 'https://existing.example.com',
      });

      // Merge new platformEndpoint
      const merged = await mergeGlobalConfig({
        platformEndpoint: 'https://platform.example.com',
      });

      expect(merged.token).toBe('existing-token');
      expect(merged.endpoint).toBe('https://existing.example.com');
      expect(merged.platformEndpoint).toBe('https://platform.example.com');
    });

    it('overwrites existing keys with new values', async () => {
      await saveGlobalConfig({ token: 'old-token' });

      const merged = await mergeGlobalConfig({ token: 'new-token' });

      expect(merged.token).toBe('new-token');
    });

    it('returns merged config and persists it', async () => {
      await saveGlobalConfig({ token: 'first' });
      await mergeGlobalConfig({ endpoint: 'https://orch.example.com' });

      // Reload from disk to verify persistence
      const reloaded = await loadGlobalConfig();
      expect(reloaded.token).toBe('first');
      expect(reloaded.endpoint).toBe('https://orch.example.com');
    });

    it('creates config from scratch when no file exists', async () => {
      const merged = await mergeGlobalConfig({
        token: 'brand-new',
        routingKey: 'github:42',
      });

      expect(merged.token).toBe('brand-new');
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
      await saveGlobalConfig({ token: 'keep-me', endpoint: 'https://keep.example.com' });

      const merged = await mergeGlobalConfig({ token: undefined });

      expect(merged.token).toBe('keep-me');
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
      await saveGlobalConfig({ token: 'custom-dir-token' });

      const configPath = path.join(customConfigDir, 'config');
      const content = await fs.readFile(configPath, 'utf-8');
      const parsed = JSON.parse(content);
      expect(parsed.token).toBe('custom-dir-token');
    });

    it('loadGlobalConfig reads from custom config dir', async () => {
      await fs.writeFile(
        path.join(customConfigDir, 'config'),
        JSON.stringify({ token: 'from-custom-dir' }),
        { mode: 0o600 },
      );

      const config = await loadGlobalConfig();
      expect(config.token).toBe('from-custom-dir');
    });
  });
});

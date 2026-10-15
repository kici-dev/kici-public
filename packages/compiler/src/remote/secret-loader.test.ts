import { describe, it, expect, vi, beforeEach } from 'vitest';
import { loadLocalSecrets } from './secret-loader.js';

vi.mock('node:fs/promises', () => ({
  readFile: vi.fn(),
}));

vi.mock('../test-runner/secrets-file.js', () => ({
  loadSecretsFile: vi.fn(),
}));

import { readFile } from 'node:fs/promises';
import { loadSecretsFile } from '../test-runner/secrets-file.js';

const mockReadFile = vi.mocked(readFile);
const mockLoadSecretsFile = vi.mocked(loadSecretsFile);

beforeEach(() => {
  vi.resetAllMocks();
  mockReadFile.mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
  mockLoadSecretsFile.mockResolvedValue({ flat: {}, contexts: {} });
});

describe('loadLocalSecrets', () => {
  it('loads .env.local file as flat key-value pairs', async () => {
    mockReadFile.mockImplementation(async (filePath) => {
      if (String(filePath).endsWith('.env.local')) {
        return 'DB_HOST=localhost\nDB_PORT=5432\n';
      }
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    });

    const result = await loadLocalSecrets('/project/.kici');
    expect(result.flat.DB_HOST).toBe('localhost');
    expect(result.flat.DB_PORT).toBe('5432');
  });

  it('loads secrets.yaml and merges all environment values flat', async () => {
    mockReadFile.mockImplementation(async (filePath) => {
      if (String(filePath).endsWith('secrets.yaml')) {
        return 'production:\n  API_KEY: prod-key\nstaging:\n  API_KEY: stg-key\n';
      }
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    });

    const result = await loadLocalSecrets('/project/.kici');
    // Later environments override earlier ones in the flat merge.
    expect(result.flat.API_KEY).toBeDefined();
  });

  it('loads .secrets INI file via loadSecretsFile, keeping its contexts', async () => {
    mockLoadSecretsFile.mockResolvedValue({
      flat: { OLD_SECRET: 'old-value' },
      contexts: { prod: { CTX_SECRET: 'ctx-value' } },
    });

    const result = await loadLocalSecrets('/project/.kici');
    expect(result.flat.OLD_SECRET).toBe('old-value');
    expect(result.contexts.prod.CTX_SECRET).toBe('ctx-value');
  });

  it('applies merge precedence: .secrets < .env.local < secrets.yaml < --env flags', async () => {
    mockLoadSecretsFile.mockResolvedValue({
      flat: { KEY: 'from-secrets', ONLY_SECRETS: 'only' },
      contexts: {},
    });

    mockReadFile.mockImplementation(async (filePath) => {
      if (String(filePath).endsWith('.env.local')) {
        return 'KEY=from-env-local\nONLY_ENV=env-only\n';
      }
      if (String(filePath).endsWith('secrets.yaml')) {
        return 'default:\n  KEY: from-yaml\n  ONLY_YAML: yaml-only\n';
      }
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    });

    const result = await loadLocalSecrets('/project/.kici', ['KEY=from-flag']);

    expect(result.flat.KEY).toBe('from-flag');
    expect(result.flat.ONLY_SECRETS).toBe('only');
    expect(result.flat.ONLY_ENV).toBe('env-only');
    expect(result.flat.ONLY_YAML).toBe('yaml-only');
  });

  it('silently ignores missing files (no errors)', async () => {
    const result = await loadLocalSecrets('/project/.kici');
    expect(result.flat).toEqual({});
    expect(result.contexts).toEqual({});
  });

  it('parses --env KEY=VALUE flags correctly', async () => {
    const result = await loadLocalSecrets('/project/.kici', [
      'API_KEY=my-secret-key',
      'DB_URL=postgres://host:5432/db',
      'EMPTY=',
    ]);

    expect(result.flat.API_KEY).toBe('my-secret-key');
    expect(result.flat.DB_URL).toBe('postgres://host:5432/db');
    expect(result.flat.EMPTY).toBe('');
  });

  it('strips surrounding quotes from .env.local values', async () => {
    mockReadFile.mockImplementation(async (filePath) => {
      if (String(filePath).endsWith('.env.local')) {
        return [
          'DOUBLE="double-quoted"',
          "SINGLE='single-quoted'",
          'UNQUOTED=no-quotes',
          'EMPTY_QUOTED=""',
          'MIXED="mismatched\'',
          'SPACES="value with spaces"',
        ].join('\n');
      }
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    });

    const result = await loadLocalSecrets('/project/.kici');
    expect(result.flat.DOUBLE).toBe('double-quoted');
    expect(result.flat.SINGLE).toBe('single-quoted');
    expect(result.flat.UNQUOTED).toBe('no-quotes');
    expect(result.flat.EMPTY_QUOTED).toBe('');
    expect(result.flat.MIXED).toBe('"mismatched\'');
    expect(result.flat.SPACES).toBe('value with spaces');
  });

  it('handles .env.local comments and blank lines', async () => {
    mockReadFile.mockImplementation(async (filePath) => {
      if (String(filePath).endsWith('.env.local')) {
        return '# This is a comment\nKEY=value\n\n# Another comment\nKEY2=value2\n';
      }
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    });

    const result = await loadLocalSecrets('/project/.kici');
    expect(result.flat.KEY).toBe('value');
    expect(result.flat.KEY2).toBe('value2');
    expect(Object.keys(result.flat)).toHaveLength(2);
  });
});

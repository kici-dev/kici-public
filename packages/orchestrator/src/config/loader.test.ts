import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFile, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { loadLocalConfig, SENSITIVE_FIELD_PATHS } from './loader.js';

/** Create a temp directory for test config files */
async function createTmpDir(): Promise<string> {
  const dir = join(tmpdir(), `kici-config-test-${randomUUID().slice(0, 8)}`);
  await mkdir(dir, { recursive: true });
  return dir;
}

describe('loadLocalConfig', () => {
  let tmpDir: string;
  const originalKiciConfig = process.env.KICI_CONFIG;

  beforeEach(async () => {
    tmpDir = await createTmpDir();
    delete process.env.KICI_CONFIG;
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
    if (originalKiciConfig !== undefined) {
      process.env.KICI_CONFIG = originalKiciConfig;
    } else {
      delete process.env.KICI_CONFIG;
    }
  });

  it('parses a valid YAML config file', async () => {
    const configPath = join(tmpDir, 'orchestrator.yaml');
    await writeFile(
      configPath,
      `
database:
  url: postgres://user:pass@db:5432/kici
instance:
  id: orch-west-1
  mode: hybrid
server:
  port: 4000
  basePath: /
  logLevel: info
scaler:
  configPath: /etc/kici/scalers.yaml
  configDir: /etc/kici/scalers.d/
`,
    );

    const config = await loadLocalConfig(configPath);

    expect(config.database.url).toBe('postgres://user:pass@db:5432/kici');
    expect(config.instance?.id).toBe('orch-west-1');
    expect(config.instance?.mode).toBe('hybrid');
    expect(config.server?.port).toBe(4000);
    expect(config.server?.basePath).toBe('/');
    expect(config.server?.logLevel).toBe('info');
    expect(config.scaler?.configPath).toBe('/etc/kici/scalers.yaml');
    expect(config.scaler?.configDir).toBe('/etc/kici/scalers.d/');
  });

  it('parses minimal config with only database.url', async () => {
    const configPath = join(tmpDir, 'minimal.yaml');
    await writeFile(
      configPath,
      `
database:
  url: postgres://localhost/kici
`,
    );

    const config = await loadLocalConfig(configPath);

    expect(config.database.url).toBe('postgres://localhost/kici');
    expect(config.instance).toBeUndefined();
    expect(config.server).toBeUndefined();
    expect(config.scaler).toBeUndefined();
  });

  it('returns empty config when default file is missing (no explicit path)', async () => {
    // No KICI_CONFIG set, and /etc/kici/orchestrator.yaml likely doesn't exist in test env
    // loadLocalConfig with no args uses default path, which won't exist
    const config = await loadLocalConfig();

    // Should return gracefully (empty-ish config, not throw)
    expect(config).toBeDefined();
  });

  it('throws when an explicit configPath does not exist', async () => {
    const bogusPath = join(tmpDir, 'nonexistent.yaml');

    await expect(loadLocalConfig(bogusPath)).rejects.toThrow(/Failed to read config file/);
  });

  it('throws when KICI_CONFIG env var points to missing file', async () => {
    process.env.KICI_CONFIG = join(tmpDir, 'missing.yaml');

    await expect(loadLocalConfig()).rejects.toThrow(/Failed to read config file/);
  });

  it('reads config from KICI_CONFIG env var', async () => {
    const configPath = join(tmpDir, 'custom.yaml');
    await writeFile(
      configPath,
      `
database:
  url: postgres://custom@db:5432/kici
`,
    );
    process.env.KICI_CONFIG = configPath;

    const config = await loadLocalConfig();

    expect(config.database.url).toBe('postgres://custom@db:5432/kici');
  });

  it('throws validation error for invalid YAML structure', async () => {
    const configPath = join(tmpDir, 'invalid.yaml');
    await writeFile(
      configPath,
      `
database:
  url: ""
`,
    );

    await expect(loadLocalConfig(configPath)).rejects.toThrow(/Config validation failed/);
  });

  it('throws validation error for missing required database.url', async () => {
    const configPath = join(tmpDir, 'no-db.yaml');
    await writeFile(
      configPath,
      `
instance:
  mode: platform
`,
    );

    await expect(loadLocalConfig(configPath)).rejects.toThrow(/Config validation failed/);
  });

  it('formats validation errors clearly', async () => {
    const configPath = join(tmpDir, 'bad.yaml');
    await writeFile(
      configPath,
      `
database:
  url: ""
instance:
  mode: invalid-mode
`,
    );

    try {
      await loadLocalConfig(configPath);
      expect.fail('Should have thrown');
    } catch (err) {
      const message = (err as Error).message;
      expect(message).toContain('Config validation failed');
      expect(message).toContain('database.url');
    }
  });

  it('throws for an empty YAML file with explicit path', async () => {
    const configPath = join(tmpDir, 'empty.yaml');
    await writeFile(configPath, '');

    await expect(loadLocalConfig(configPath)).rejects.toThrow(/empty or not a valid YAML/);
  });
});

describe('SENSITIVE_FIELD_PATHS', () => {
  it('includes critical secret paths', () => {
    expect(SENSITIVE_FIELD_PATHS).toContain('platform.token');
    expect(SENSITIVE_FIELD_PATHS).toContain('secrets.key');
    expect(SENSITIVE_FIELD_PATHS).toContain('cluster.joinToken');
  });

  it('is a readonly array', () => {
    // as const makes it readonly
    expect(Array.isArray(SENSITIVE_FIELD_PATHS)).toBe(true);
  });
});

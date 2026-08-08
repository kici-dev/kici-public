import { describe, it, expect, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  resolveWizardMode,
  buildStubEnv,
  writeInstallEnvFile,
  COMPOSE_QUICKSTART_URL,
} from './install-env.js';

vi.mock('../../wizard/orchestrator-wizard.js', () => ({
  runOrchestratorWizard: vi.fn(),
}));
import { runOrchestratorWizard } from '../../wizard/orchestrator-wizard.js';

describe('resolveWizardMode', () => {
  const base = { isTTY: false, isCI: false } as const;

  it('an --env-file always selects env-file mode (even on a TTY)', () => {
    expect(resolveWizardMode({ ...base, isTTY: true, envFile: '/x.env' })).toBe('env-file');
  });

  it('explicit --wizard selects wizard mode even without a TTY', () => {
    expect(resolveWizardMode({ ...base, wizard: true })).toBe('wizard');
  });

  it('explicit --no-wizard selects stub mode even on a TTY', () => {
    expect(resolveWizardMode({ ...base, isTTY: true, wizard: false })).toBe('stub');
  });

  it('--dev keeps stub mode on a TTY (dev provisions the DB, no wizard)', () => {
    expect(resolveWizardMode({ ...base, isTTY: true, dev: true })).toBe('stub');
  });

  it('a bare interactive terminal defaults to wizard mode', () => {
    expect(resolveWizardMode({ ...base, isTTY: true })).toBe('wizard');
  });

  it('a bare non-TTY install defaults to stub mode', () => {
    expect(resolveWizardMode({ ...base, isTTY: false })).toBe('stub');
  });

  it('a TTY under CI defaults to stub mode (CI is non-interactive)', () => {
    expect(resolveWizardMode({ ...base, isTTY: true, isCI: true })).toBe('stub');
  });
});

describe('buildStubEnv', () => {
  it('enumerates every required key', () => {
    const env = buildStubEnv({});
    for (const key of [
      'KICI_MODE',
      'KICI_DATABASE_URL',
      'KICI_PLATFORM_URL',
      'KICI_PLATFORM_TOKEN',
      'KICI_SECRET_KEY',
      'KICI_BOOTSTRAP_ADMIN_TOKEN',
    ]) {
      expect(env).toContain(key);
    }
  });

  it('includes a secret generation command and the compose quickstart pointer', () => {
    const env = buildStubEnv({});
    expect(env).toContain('openssl rand -hex 32');
    expect(env).toContain(COMPOSE_QUICKSTART_URL);
  });

  it('cross-references the two token vocabularies', () => {
    const env = buildStubEnv({});
    expect(env).toContain('kici_ok_');
    expect(env).toContain('kici_join_v1');
  });

  it('fills KICI_DATABASE_URL from a provided dev DB URL', () => {
    const env = buildStubEnv({ devDbUrl: 'postgresql://postgres:pw@localhost:15432/kici' });
    expect(env).toContain('KICI_DATABASE_URL=postgresql://postgres:pw@localhost:15432/kici');
  });

  it('leaves KICI_DATABASE_URL as a placeholder when no dev DB URL is given', () => {
    const env = buildStubEnv({});
    expect(env).toMatch(/^KICI_DATABASE_URL=.+$/m);
    expect(env).not.toContain('localhost:15432');
  });
});

describe('writeInstallEnvFile', () => {
  let dir: string;
  afterEach(() => {
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('stub mode writes the enumerated stub when the file is absent', async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kici-env-'));
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const envFilePath = path.join(dir, 'svc.env');
    await writeInstallEnvFile({ mode: 'stub', envFilePath });
    expect(fs.readFileSync(envFilePath, 'utf-8')).toContain('KICI_BOOTSTRAP_ADMIN_TOKEN');
  });

  it('stub mode appends KICI_DATABASE_URL to an existing file when a dev DB URL is set', async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kici-env-'));
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const envFilePath = path.join(dir, 'svc.env');
    fs.writeFileSync(envFilePath, '# existing\n', 'utf-8');
    await writeInstallEnvFile({
      mode: 'stub',
      envFilePath,
      devDbUrl: 'postgresql://postgres:pw@localhost:15432/kici',
    });
    const content = fs.readFileSync(envFilePath, 'utf-8');
    expect(content).toContain('# existing');
    expect(content).toContain('KICI_DATABASE_URL=postgresql://postgres:pw@localhost:15432/kici');
  });

  it('env-file mode copies the source file', async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kici-env-'));
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const source = path.join(dir, 'source.env');
    fs.writeFileSync(source, 'KICI_MODE=independent\n', 'utf-8');
    const envFilePath = path.join(dir, 'svc.env');
    await writeInstallEnvFile({ mode: 'env-file', envFilePath, envFileSource: source });
    expect(fs.readFileSync(envFilePath, 'utf-8')).toContain('KICI_MODE=independent');
  });

  it('env-file mode throws when the source file is missing', async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kici-env-'));
    await expect(
      writeInstallEnvFile({
        mode: 'env-file',
        envFilePath: path.join(dir, 'svc.env'),
        envFileSource: path.join(dir, 'missing.env'),
      }),
    ).rejects.toThrow(/env file not found/);
  });

  it('wizard mode returns the sourceHint when the operator configured a source', async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kici-env-'));
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.mocked(runOrchestratorWizard).mockResolvedValue({
      mode: 'platform',
      databaseUrl: 'postgresql://kici:pw@localhost:5432/kici',
      port: 4000,
      secretsKey: 'k',
      bootstrapAdminToken: 't',
      platformUrl: 'wss://api.kici.dev/ws',
      platformToken: 'p',
      source: {
        name: 'main-org',
        appId: '12345',
        privateKeyPath: '/home/op/k.pem',
        webhookSecret: 's',
      },
    });
    const res = await writeInstallEnvFile({
      mode: 'wizard',
      envFilePath: path.join(dir, 'svc.env'),
    });
    expect(res.sourceHint).toEqual({
      name: 'main-org',
      appId: '12345',
      privateKeyPath: '/home/op/k.pem',
      webhookSecret: 's',
    });
  });

  it('wizard mode returns no sourceHint when no source was configured', async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kici-env-'));
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.mocked(runOrchestratorWizard).mockResolvedValue({
      mode: 'platform',
      databaseUrl: 'postgresql://kici:pw@localhost:5432/kici',
      port: 4000,
      secretsKey: 'k',
      bootstrapAdminToken: 't',
      platformUrl: 'wss://api.kici.dev/ws',
      platformToken: 'p',
    });
    const res = await writeInstallEnvFile({
      mode: 'wizard',
      envFilePath: path.join(dir, 'svc.env'),
    });
    expect(res.sourceHint).toBeUndefined();
  });

  it('stub mode returns an empty result', async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kici-env-'));
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const res = await writeInstallEnvFile({ mode: 'stub', envFilePath: path.join(dir, 'svc.env') });
    expect(res.sourceHint).toBeUndefined();
  });
});

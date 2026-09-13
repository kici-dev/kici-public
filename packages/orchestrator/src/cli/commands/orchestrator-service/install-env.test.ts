import { describe, it, expect, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  resolveWizardMode,
  buildStubEnv,
  writeInstallEnvFile,
  COMPOSE_QUICKSTART_URL,
  GITHUB_INGRESS_URL,
  DEFAULT_INSTALL_MODE,
} from './install-env.js';
import { ENV_FILE_MODE } from '../shared/env-file-mode.js';
import { selectServerEntry } from '../../service/entrypoint.js';

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

  it('defaults KICI_MODE to hybrid', () => {
    expect(DEFAULT_INSTALL_MODE).toBe('hybrid');
    expect(buildStubEnv({})).toContain('KICI_MODE=hybrid');
  });

  it('describes hybrid as the default and lists every other mode', () => {
    const env = buildStubEnv({});
    expect(env).toContain('# Operating mode: hybrid (default');
    expect(env).toContain('Platform relay + direct webhook ingress');
    for (const other of ['platform', 'observed', 'independent']) {
      expect(env).toContain(other);
    }
  });

  it('writes the mode the operator named', () => {
    expect(buildStubEnv({ mode: 'platform' })).toContain('KICI_MODE=platform');
    expect(buildStubEnv({ mode: 'independent' })).toContain('KICI_MODE=independent');
  });

  it('carries a commented KICI_WEBHOOK_PUBLIC_URL pointing at the ingress guide', () => {
    const env = buildStubEnv({});
    expect(env).toContain('# KICI_WEBHOOK_PUBLIC_URL=');
    expect(env).toContain(GITHUB_INGRESS_URL);
    // Commented out, so a fresh hybrid install advertises no ingress until the
    // operator opts in.
    expect(env).not.toMatch(/^KICI_WEBHOOK_PUBLIC_URL=/m);
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

  it('stub mode writes the orchestratorMode it was given', async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kici-env-'));
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const envFilePath = path.join(dir, 'svc.env');
    await writeInstallEnvFile({ mode: 'stub', envFilePath, orchestratorMode: 'observed' });
    expect(fs.readFileSync(envFilePath, 'utf-8')).toContain('KICI_MODE=observed');
  });

  it('wizard mode preselects the orchestratorMode it was given', async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kici-env-'));
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.mocked(runOrchestratorWizard).mockResolvedValue({
      mode: 'hybrid',
      databaseUrl: 'postgresql://kici:pw@localhost:5432/kici',
      port: 4000,
      secretsKey: 'k',
      bootstrapAdminToken: 't',
      platformUrl: 'wss://api.kici.dev/ws',
      platformToken: 'p',
      webhookPublicUrl: 'https://ci.example.com',
    });
    const envFilePath = path.join(dir, 'svc.env');
    await writeInstallEnvFile({ mode: 'wizard', envFilePath, orchestratorMode: 'independent' });
    expect(vi.mocked(runOrchestratorWizard)).toHaveBeenCalledWith({ defaultMode: 'independent' });
    const content = fs.readFileSync(envFilePath, 'utf-8');
    expect(content).toContain('KICI_MODE=hybrid');
    expect(content).toContain('KICI_WEBHOOK_PUBLIC_URL=https://ci.example.com');
  });

  // The install bakes the service unit's entry point from KICI_MODE, so
  // `--mode` has to land in the copied file. Asserting the written line alone
  // would not show that: `selectServerEntry` is what install actually calls,
  // and it reads only an uncommented assignment.
  it('env-file mode writes a named --mode, so the unit runs the standalone entry', async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kici-env-'));
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const source = path.join(dir, 'source.env');
    // The shape `kici-admin join` writes: KICI_MODE appears only in the header
    // comment, so nothing uncommented declares it.
    fs.writeFileSync(source, '#   KICI_MODE=hybrid\nKICI_DATABASE_URL=postgres://x\n', 'utf-8');
    const envFilePath = path.join(dir, 'svc.env');
    await writeInstallEnvFile({
      mode: 'env-file',
      envFilePath,
      envFileSource: source,
      orchestratorMode: 'independent',
      modeExplicit: true,
    });
    const content = fs.readFileSync(envFilePath, 'utf-8');
    expect(content).toContain('KICI_MODE=independent');
    expect(content).toContain('KICI_DATABASE_URL=postgres://x');
    expect(selectServerEntry(content)).toBe('standalone');
  });

  // breaks-if-wrong: --mode carries a Commander default, so a defaulted
  //   `hybrid` must not overwrite a mode the operator already put in the file.
  it('env-file mode leaves an existing KICI_MODE alone when --mode was defaulted', async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kici-env-'));
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const source = path.join(dir, 'source.env');
    fs.writeFileSync(source, 'KICI_MODE=independent\n', 'utf-8');
    const envFilePath = path.join(dir, 'svc.env');
    await writeInstallEnvFile({
      mode: 'env-file',
      envFilePath,
      envFileSource: source,
      orchestratorMode: DEFAULT_INSTALL_MODE,
      modeExplicit: false,
    });
    const content = fs.readFileSync(envFilePath, 'utf-8');
    expect(content).toBe('KICI_MODE=independent\n');
    expect(selectServerEntry(content)).toBe('standalone');
  });

  // A named --mode is the operator's most recent instruction, so it replaces
  // the assignment already in the file rather than appending a second one.
  it('env-file mode replaces an existing KICI_MODE when --mode names another', async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kici-env-'));
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const source = path.join(dir, 'source.env');
    fs.writeFileSync(source, '# mode\nKICI_MODE=hybrid\nKICI_PORT=4000\n', 'utf-8');
    const envFilePath = path.join(dir, 'svc.env');
    await writeInstallEnvFile({
      mode: 'env-file',
      envFilePath,
      envFileSource: source,
      orchestratorMode: 'independent',
      modeExplicit: true,
    });
    expect(fs.readFileSync(envFilePath, 'utf-8')).toBe(
      '# mode\nKICI_MODE=independent\nKICI_PORT=4000\n',
    );
  });

  // breaks-if-wrong: the other two branches own KICI_MODE themselves and must
  //   not gain a second assignment from the env-file path's upsert.
  it('a named --mode leaves the stub and wizard branches unchanged', async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kici-env-'));
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const stubPath = path.join(dir, 'stub.env');
    await writeInstallEnvFile({
      mode: 'stub',
      envFilePath: stubPath,
      orchestratorMode: 'observed',
      modeExplicit: true,
    });
    expect(fs.readFileSync(stubPath, 'utf-8').match(/^KICI_MODE=/gm)).toHaveLength(1);

    vi.mocked(runOrchestratorWizard).mockResolvedValue({
      mode: 'platform',
      databaseUrl: 'postgresql://kici:pw@localhost:5432/kici',
      port: 4000,
      secretsKey: 'k',
      bootstrapAdminToken: 't',
    });
    const wizardPath = path.join(dir, 'wizard.env');
    await writeInstallEnvFile({
      mode: 'wizard',
      envFilePath: wizardPath,
      orchestratorMode: 'observed',
      modeExplicit: true,
    });
    const wizardContent = fs.readFileSync(wizardPath, 'utf-8');
    expect(wizardContent.match(/^KICI_MODE=/gm)).toHaveLength(1);
    expect(wizardContent).toContain('KICI_MODE=platform');
  });

  it('stub mode returns an empty result', async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kici-env-'));
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const res = await writeInstallEnvFile({ mode: 'stub', envFilePath: path.join(dir, 'svc.env') });
    expect(res.sourceHint).toBeUndefined();
  });
});

describe('install env file permissions', () => {
  let dir: string;
  afterEach(() => {
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  const wizardConfig = {
    mode: 'hybrid' as const,
    databaseUrl: 'postgresql://kici:pw@localhost:5432/kici',
    port: 4000,
    secretsKey: 'k',
    bootstrapAdminToken: 't',
  };

  // fails-when: any write path leaves the file group- or world-readable. It
  //   holds KICI_SECRET_KEY, KICI_DATABASE_URL and KICI_PLATFORM_TOKEN, so a
  //   0644 file publishes the cluster's master key to every local account.
  //   Each case drives a different branch: the wizard and stub branches create
  //   the file, the env-file branch copies one (inheriting the source's mode),
  //   and the last starts from a file that already exists at 0644.
  it.each([
    [
      'wizard',
      async (envFilePath: string) => {
        vi.mocked(runOrchestratorWizard).mockResolvedValue(wizardConfig);
        await writeInstallEnvFile({ mode: 'wizard', envFilePath });
      },
    ],
    [
      'stub',
      async (envFilePath: string) => {
        await writeInstallEnvFile({ mode: 'stub', envFilePath });
      },
    ],
    [
      'env-file copy of a world-readable source',
      async (envFilePath: string) => {
        const source = path.join(path.dirname(envFilePath), 'source.env');
        fs.writeFileSync(source, 'KICI_SECRET_KEY=abc\n', { encoding: 'utf-8', mode: 0o644 });
        fs.chmodSync(source, 0o644);
        await writeInstallEnvFile({ mode: 'env-file', envFilePath, envFileSource: source });
      },
    ],
    [
      'stub over a pre-existing world-readable file',
      async (envFilePath: string) => {
        fs.writeFileSync(envFilePath, 'KICI_SECRET_KEY=abc\n', { encoding: 'utf-8', mode: 0o644 });
        fs.chmodSync(envFilePath, 0o644);
        await writeInstallEnvFile({ mode: 'stub', envFilePath });
      },
    ],
  ])('%s writes an env file readable by its owner only', async (_label, write) => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kici-env-mode-'));
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const envFilePath = path.join(dir, 'svc.env');

    await write(envFilePath);

    expect(fs.statSync(envFilePath).mode & 0o777).toBe(ENV_FILE_MODE);
    // breaks-if-wrong: the installing user must still be able to read the file
    // back — `install` re-reads it to stamp KICI_DEPLOY_* and to pick the
    // server entry point, and the service unit reads it at every start.
    expect(fs.readFileSync(envFilePath, 'utf-8').length).toBeGreaterThan(0);
  });

  // The assertions above read the mode after the write, which says nothing
  // about the moment before the chmod. A second hard link on the destination
  // makes that moment observable: a write through the old inode would put
  // KICI_SECRET_KEY on a file that is still 0644 until the chmod lands.
  // fails-when: the copy path uses copyFileSync + chmod.
  it('never writes the copied secrets through a pre-existing world-readable file', async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kici-env-mode-'));
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const envFilePath = path.join(dir, 'svc.env');
    const keeper = path.join(dir, 'keeper');
    fs.writeFileSync(envFilePath, 'stale\n', { encoding: 'utf-8', mode: 0o644 });
    fs.chmodSync(envFilePath, 0o644);
    fs.linkSync(envFilePath, keeper);
    const source = path.join(dir, 'source.env');
    fs.writeFileSync(source, 'KICI_SECRET_KEY=abc\n', { encoding: 'utf-8', mode: 0o644 });
    fs.chmodSync(source, 0o644);

    await writeInstallEnvFile({ mode: 'env-file', envFilePath, envFileSource: source });

    expect(fs.readFileSync(envFilePath, 'utf-8')).toContain('KICI_SECRET_KEY=abc');
    expect(fs.statSync(envFilePath).mode & 0o777).toBe(ENV_FILE_MODE);
    expect(fs.readFileSync(keeper, 'utf-8')).toBe('stale\n');
    expect(fs.statSync(keeper).mode & 0o777).toBe(0o644);
  });
});

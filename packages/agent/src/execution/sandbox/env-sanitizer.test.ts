import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { buildSanitizedEnv } from './env-sanitizer.js';
import { ALLOWED_SYSTEM_VARS } from '@kici-dev/engine';

describe('buildSanitizedEnv', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('includes only allowlisted system vars', () => {
    process.env.PATH = '/usr/bin:/bin';
    process.env.HOME = '/home/testuser';
    process.env.LANG = 'en_US.UTF-8';
    process.env.RANDOM_VAR = 'leaked';

    const env = buildSanitizedEnv({});

    expect(env.PATH).toBe('/usr/bin:/bin');
    expect(env.HOME).toBe('/home/testuser');
    expect(env.LANG).toBe('en_US.UTF-8');
    expect(env).not.toHaveProperty('RANDOM_VAR');
  });

  it('excludes agent-internal credentials', () => {
    process.env.KICI_ORCHESTRATOR_URL = 'ws://orch:8080';
    process.env.KICI_AGENT_ID = 'agent-1';
    process.env.KICI_DATABASE_URL = 'postgres://localhost:5432/kici';
    process.env.KICI_PLATFORM_TOKEN = 'secret';
    process.env.WEBHOOK_SECRET = 'hmac-key';

    const env = buildSanitizedEnv({});

    expect(env).not.toHaveProperty('KICI_ORCHESTRATOR_URL');
    expect(env).not.toHaveProperty('KICI_AGENT_ID');
    expect(env).not.toHaveProperty('KICI_DATABASE_URL');
    expect(env).not.toHaveProperty('KICI_PLATFORM_TOKEN');
    expect(env).not.toHaveProperty('WEBHOOK_SECRET');
  });

  it('includes user env vars', () => {
    const env = buildSanitizedEnv({ MY_VAR: 'hello', API_KEY: 'user-key' });

    expect(env.MY_VAR).toBe('hello');
    expect(env.API_KEY).toBe('user-key');
  });

  it('does not include undefined system vars', () => {
    // Ensure TMPDIR is not set
    delete process.env.TMPDIR;

    const env = buildSanitizedEnv({});

    expect(env).not.toHaveProperty('TMPDIR');
  });

  it('user env vars override system vars', () => {
    process.env.PATH = '/usr/bin';

    const env = buildSanitizedEnv({ PATH: '/custom/bin' });

    expect(env.PATH).toBe('/custom/bin');
  });

  it('includes FORCE_COLOR=1 by default for ANSI color support', () => {
    const env = buildSanitizedEnv({});

    expect(env.FORCE_COLOR).toBe('1');
  });

  it('allows user to override FORCE_COLOR', () => {
    const env = buildSanitizedEnv({ FORCE_COLOR: '0' });

    expect(env.FORCE_COLOR).toBe('0');
  });

  // -- 7-layer merge tests for environment vars --

  it('includes environment vars at correct precedence (after user env)', () => {
    const env = buildSanitizedEnv(
      { KICI_RUN_ID: 'r1' },
      {
        environmentVars: { DB_HOST: 'prod-db', API_URL: 'https://api.example.com' },
      },
    );

    expect(env.DB_HOST).toBe('prod-db');
    expect(env.API_URL).toBe('https://api.example.com');
    expect(env.KICI_RUN_ID).toBe('r1');
  });

  it('job env overrides environment vars', () => {
    const env = buildSanitizedEnv(
      {},
      {
        environmentVars: { NODE_ENV: 'staging' },
        jobEnv: { NODE_ENV: 'production' },
      },
    );

    expect(env.NODE_ENV).toBe('production');
  });

  it('environment vars override user env', () => {
    const env = buildSanitizedEnv(
      { APP_ENV: 'user' },
      {
        environmentVars: { APP_ENV: 'org-level' },
      },
    );

    expect(env.APP_ENV).toBe('org-level');
  });

  it('full 7-layer merge produces correct precedence', () => {
    process.env.HOME = '/home/original';

    const env = buildSanitizedEnv(
      { KICI_RUN_ID: 'r1', SHARED: 'user' },
      {
        environmentVars: { ORG_VAR: 'org', SHARED: 'org' },
        jobEnv: { JOB_VAR: 'job', SHARED: 'job' },
      },
    );

    // Layer 1: system vars
    expect(env.HOME).toBe('/home/original');
    // Layer 2: sandbox defaults
    expect(env.FORCE_COLOR).toBe('1');
    // Layer 3: user env
    expect(env.KICI_RUN_ID).toBe('r1');
    // Layer 4-5: environment vars
    expect(env.ORG_VAR).toBe('org');
    // Layer 6: job env (highest non-runtime precedence)
    expect(env.JOB_VAR).toBe('job');
    // SHARED gets job env value (highest non-runtime precedence)
    expect(env.SHARED).toBe('job');
  });
});

describe('ALLOWED_SYSTEM_VARS', () => {
  it('includes expected system vars', () => {
    const expected = [
      'PATH',
      'HOME',
      'USER',
      'LANG',
      'LC_ALL',
      'TERM',
      'TMPDIR',
      'NODE_PATH',
      'TZ',
    ];

    for (const v of expected) {
      expect(ALLOWED_SYSTEM_VARS).toContain(v);
    }
  });

  it('includes Windows-essential system vars (PATHEXT et al.)', () => {
    // Without PATHEXT a Windows step cannot resolve a bare command name to its
    // .exe — a regression that broke mise-installed tools (e.g. jq) on Windows.
    const windowsVars = [
      'PATHEXT',
      'SystemRoot',
      'windir',
      'COMSPEC',
      'TEMP',
      'TMP',
      'USERPROFILE',
      'LOCALAPPDATA',
      'APPDATA',
      'PROCESSOR_ARCHITECTURE',
      'NUMBER_OF_PROCESSORS',
    ];
    for (const v of windowsVars) {
      expect(ALLOWED_SYSTEM_VARS).toContain(v);
    }
  });

  it('passes PATHEXT through buildSanitizedEnv when present (Windows command resolution)', () => {
    process.env.PATHEXT = '.COM;.EXE;.BAT;.CMD';
    const env = buildSanitizedEnv({});
    expect(env.PATHEXT).toBe('.COM;.EXE;.BAT;.CMD');
  });

  it('does not include any KICI_ prefixed var', () => {
    for (const v of ALLOWED_SYSTEM_VARS) {
      expect(v).not.toMatch(/^KICI_/);
    }
  });

  it('is a readonly tuple', () => {
    // Verify it is an array (as const produces a readonly tuple)
    expect(Array.isArray(ALLOWED_SYSTEM_VARS)).toBe(true);
    expect(ALLOWED_SYSTEM_VARS.length).toBeGreaterThan(0);
  });
});

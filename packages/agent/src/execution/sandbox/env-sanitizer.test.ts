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
        contextVars: { DB_HOST: 'prod-db', API_URL: 'https://api.example.com' },
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
        contextVars: { NODE_ENV: 'staging' },
        jobEnv: { NODE_ENV: 'production' },
      },
    );

    expect(env.NODE_ENV).toBe('production');
  });

  it('environment vars override user env', () => {
    const env = buildSanitizedEnv(
      { APP_ENV: 'user' },
      {
        contextVars: { APP_ENV: 'org-level' },
      },
    );

    expect(env.APP_ENV).toBe('org-level');
  });

  it('full 7-layer merge produces correct precedence', () => {
    process.env.HOME = '/home/original';

    const env = buildSanitizedEnv(
      { KICI_RUN_ID: 'r1', SHARED: 'user' },
      {
        contextVars: { ORG_VAR: 'org', SHARED: 'org' },
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

describe('buildSanitizedEnv trusted-env profile', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('passes the ambient host env through, minus the agent KiCI identity + infra secrets', () => {
    process.env.PATH = '/usr/bin';
    process.env.AWS_ACCESS_KEY_ID = 'AKIA';
    process.env.SOPS_AGE_KEY_FILE = '/keys/age';
    process.env.SSH_AUTH_SOCK = '/tmp/ssh';
    process.env.TRUSTED_ENV_PROBE = 'ambient-visible';
    process.env.KICI_AGENT_TOKEN = 'kat_secret';
    process.env.KICI_SECRET_KEY = 'deadbeef';
    process.env.KICI_ORCHESTRATOR_URL = 'ws://orch';
    process.env.DATABASE_URL = 'postgres://x';

    const env = buildSanitizedEnv({}, { trustedEnv: true });

    // Ambient host env reaches the step.
    expect(env.PATH).toBe('/usr/bin');
    expect(env.AWS_ACCESS_KEY_ID).toBe('AKIA');
    expect(env.SOPS_AGE_KEY_FILE).toBe('/keys/age');
    expect(env.SSH_AUTH_SOCK).toBe('/tmp/ssh');
    expect(env.TRUSTED_ENV_PROBE).toBe('ambient-visible');
    // The agent's own identity/operational secrets are still scrubbed.
    expect(env).not.toHaveProperty('KICI_AGENT_TOKEN');
    expect(env).not.toHaveProperty('KICI_SECRET_KEY');
    expect(env).not.toHaveProperty('KICI_ORCHESTRATOR_URL');
    expect(env).not.toHaveProperty('DATABASE_URL');
  });

  it('is byte-identical to the allowlist output when trustedEnv is off (default)', () => {
    process.env.PATH = '/usr/bin';
    process.env.HOME = '/home/x';
    process.env.AWS_ACCESS_KEY_ID = 'AKIA'; // ambient, non-allowlisted
    process.env.TRUSTED_ENV_PROBE = 'ambient';

    const off = buildSanitizedEnv({ FOO: '1' }, { trustedEnv: false });
    const omitted = buildSanitizedEnv({ FOO: '1' });

    expect(off).toEqual(omitted);
    // The allowlist-only path never leaks the ambient AWS/probe vars.
    expect(off).not.toHaveProperty('AWS_ACCESS_KEY_ID');
    expect(off).not.toHaveProperty('TRUSTED_ENV_PROBE');
    expect(off.PATH).toBe('/usr/bin');
    expect(off.HOME).toBe('/home/x');
    expect(off.FOO).toBe('1');
  });

  it('a dispatch-supplied KICI_TRUSTED_ENV does NOT elevate to passthrough', () => {
    process.env.PATH = '/usr/bin';
    process.env.AWS_ACCESS_KEY_ID = 'AKIA'; // ambient — must stay hidden

    // trustedEnv comes from agent config only; a jobConfig-derived value that
    // happens to be named KICI_TRUSTED_ENV is just a passed env var and MUST
    // NOT flip Layer 1 into passthrough.
    const env = buildSanitizedEnv({ KICI_TRUSTED_ENV: 'true' }, { trustedEnv: false });

    expect(env).not.toHaveProperty('AWS_ACCESS_KEY_ID');
    // The literal value still merges as a normal Layer-3 env var, but confers
    // no host-env access.
    expect(env.KICI_TRUSTED_ENV).toBe('true');
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

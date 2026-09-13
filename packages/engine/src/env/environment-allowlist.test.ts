import { describe, it, expect } from 'vitest';
import {
  buildTrustedPassthroughEnv,
  isTrustedEnvScrubbed,
  TRUSTED_ENV_SCRUB_EXACT,
} from './environment-allowlist.js';

describe('isTrustedEnvScrubbed', () => {
  it('scrubs the entire KICI_* namespace', () => {
    expect(isTrustedEnvScrubbed('KICI_AGENT_TOKEN')).toBe(true);
    expect(isTrustedEnvScrubbed('KICI_SECRET_KEY')).toBe(true);
    expect(isTrustedEnvScrubbed('KICI_BOOTSTRAP_ADMIN_TOKEN')).toBe(true);
    expect(isTrustedEnvScrubbed('KICI_ORCHESTRATOR_URL')).toBe(true);
    expect(isTrustedEnvScrubbed('KICI_TRUSTED_ENV')).toBe(true);
  });

  it('scrubs the non-KICI infra-secret denylist', () => {
    for (const key of TRUSTED_ENV_SCRUB_EXACT) {
      expect(isTrustedEnvScrubbed(key)).toBe(true);
    }
  });

  it('does not scrub ordinary host env', () => {
    expect(isTrustedEnvScrubbed('PATH')).toBe(false);
    expect(isTrustedEnvScrubbed('AWS_ACCESS_KEY_ID')).toBe(false);
    expect(isTrustedEnvScrubbed('SOPS_AGE_KEY_FILE')).toBe(false);
    expect(isTrustedEnvScrubbed('SSH_AUTH_SOCK')).toBe(false);
    expect(isTrustedEnvScrubbed('TRUSTED_ENV_PROBE')).toBe(false);
  });
});

describe('buildTrustedPassthroughEnv', () => {
  it('keeps ambient host env, drops the agent KiCI identity + infra secrets', () => {
    const out = buildTrustedPassthroughEnv({
      PATH: '/usr/bin',
      AWS_ACCESS_KEY_ID: 'AKIA',
      SOPS_AGE_KEY_FILE: '/keys/age',
      SSH_AUTH_SOCK: '/tmp/ssh',
      TRUSTED_ENV_PROBE: 'visible',
      KICI_AGENT_TOKEN: 'kat_xxx',
      KICI_SECRET_KEY: 'deadbeef',
      KICI_BOOTSTRAP_ADMIN_TOKEN: 'admin',
      KICI_ORCHESTRATOR_URL: 'ws://x',
      KICI_TRUSTED_ENV: 'true',
      DATABASE_URL: 'postgres://x',
      PLATFORM_TOKEN: 'kici_ok_x',
      WEBHOOK_SECRET: 'whsec',
      GITHUB_PRIVATE_KEY: '-----BEGIN',
    });

    expect(out).toEqual({
      PATH: '/usr/bin',
      AWS_ACCESS_KEY_ID: 'AKIA',
      SOPS_AGE_KEY_FILE: '/keys/age',
      SSH_AUTH_SOCK: '/tmp/ssh',
      TRUSTED_ENV_PROBE: 'visible',
    });
  });

  it('drops undefined-valued keys', () => {
    const out = buildTrustedPassthroughEnv({ FOO: 'bar', MISSING: undefined });
    expect(out).toEqual({ FOO: 'bar' });
  });
});

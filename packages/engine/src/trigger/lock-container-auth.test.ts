import { describe, it, expect } from 'vitest';
import { SCHEMA_VERSION } from './types.js';
import type { LockJob } from './types.js';

describe('lock schema container.auth', () => {
  it('landed after the additive container.auth bump', () => {
    // types.test.ts pins the exact version; re-pinning here would churn every
    // bump. This only checks that container.auth is inside the readable window.
    expect(SCHEMA_VERSION).toBeGreaterThanOrEqual(38);
  });

  it('carries registry auth on the container object', () => {
    const job = {
      container: {
        image: 'reg:5000/acme/ci:1.2',
        auth: { usernameSecret: 'prod:u', tokenSecret: 'prod:t' },
      },
    } satisfies Pick<LockJob, 'container'>;

    expect(job.container.auth).toEqual({ usernameSecret: 'prod:u', tokenSecret: 'prod:t' });
  });

  it('carries the *Value half of each Sourced pair', () => {
    const job = {
      container: { image: 'ghcr.io/acme/ci:1', auth: { tokenValue: 'runtime-token' } },
    } satisfies Pick<LockJob, 'container'>;

    expect(job.container.auth).toEqual({ tokenValue: 'runtime-token' });
  });

  it('still accepts a bare image string and an auth-less object', () => {
    const bare = { container: 'python:3.12-slim' } satisfies Pick<LockJob, 'container'>;
    const obj = { container: { image: 'python:3.12-slim' } } satisfies Pick<LockJob, 'container'>;
    expect(bare.container).toBe('python:3.12-slim');
    expect(obj.container.image).toBe('python:3.12-slim');
  });
});

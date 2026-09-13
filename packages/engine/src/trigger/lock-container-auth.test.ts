import { describe, it, expect } from 'vitest';
import { SCHEMA_VERSION, BREAKING_FLOOR } from './types.js';
import type { LockJob } from './types.js';

describe('lock schema container.auth', () => {
  it('landed after the additive container.auth bump', () => {
    // The exact current version is pinned once, in types.test.ts. Re-pinning it
    // per feature only churns every later bump; what this file cares about is
    // that container.auth is inside the readable window.
    expect(SCHEMA_VERSION).toBeGreaterThanOrEqual(38);
  });

  it('kept the breaking floor where it was — the bump is additive', () => {
    // An additive bump must NOT move the floor: a v30 lock still reads
    // correctly here, and moving it would reject locks we can still parse.
    expect(BREAKING_FLOOR).toBe(30);
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

import { describe, it, expect } from 'vitest';
import { SCHEMA_VERSION, BREAKING_FLOOR } from './types.js';
import type { LockJob } from './types.js';

describe('lock schema container.dockerfile', () => {
  it('bumped SCHEMA_VERSION for the additive dockerfile build fields', () => {
    expect(SCHEMA_VERSION).toBe(39);
  });

  it('kept the breaking floor where it was — the bump is additive', () => {
    // An additive bump must NOT move the floor: a v30 lock still reads
    // correctly here, and moving it would reject locks we can still parse.
    expect(BREAKING_FLOOR).toBe(30);
  });

  it('carries a dockerfile build with its context, target and args', () => {
    const job = {
      container: {
        dockerfile: '.kici/ci.Dockerfile',
        context: '.',
        target: 'ci',
        args: { NODE_VERSION: '24' },
      },
    } satisfies Pick<LockJob, 'container'>;

    expect(job.container).toEqual({
      dockerfile: '.kici/ci.Dockerfile',
      context: '.',
      target: 'ci',
      args: { NODE_VERSION: '24' },
    });
  });

  it('carries the registry host a dockerfile build needs on its auth', () => {
    // A dockerfile build has no image reference to derive the registry from —
    // the base is named inside the Dockerfile — so the author supplies it.
    const job = {
      container: {
        dockerfile: 'Dockerfile',
        auth: { registry: 'reg.internal:5000', tokenSecret: 'prod:t' },
      },
    } satisfies Pick<LockJob, 'container'>;

    expect(job.container.auth?.registry).toBe('reg.internal:5000');
  });
});

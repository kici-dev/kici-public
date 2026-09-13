import { describe, it, expect } from 'vitest';
import { job } from './job.js';
import { step } from './step.js';

describe('ContainerConfig.auth', () => {
  it('carries per-job registry auth through the job factory', () => {
    const j = job('build', {
      container: {
        image: 'reg:5000/acme/ci:1.2',
        auth: { usernameSecret: 'prod:u', tokenSecret: 'prod:t' },
      },
      runsOn: ['kici:os:linux'],
      steps: [step('noop', { run: async () => {} })],
    });
    expect(j.container).toEqual({
      image: 'reg:5000/acme/ci:1.2',
      auth: { usernameSecret: 'prod:u', tokenSecret: 'prod:t' },
    });
  });

  it('accepts a runtime-derived token via the *Value half', () => {
    // A token fetched during the run has no secret-store entry to name, so the
    // `*Value` half of the Sourced pair carries the material itself.
    const j = job('build', {
      container: { image: 'reg:5000/acme/ci:1.2', auth: { tokenValue: 'fetched-at-runtime' } },
      runsOn: ['kici:os:linux'],
      steps: [step('noop', { run: async () => {} })],
    });
    expect(j.container).toMatchObject({ auth: { tokenValue: 'fetched-at-runtime' } });
  });

  it('accepts a plain username alongside a token secret', () => {
    const j = job('build', {
      container: {
        image: 'ghcr.io/acme/ci:1.2',
        auth: { username: 'x-token', tokenSecret: 'p:t' },
      },
      runsOn: ['kici:os:linux'],
      steps: [step('noop', { run: async () => {} })],
    });
    expect(j.container).toMatchObject({ auth: { username: 'x-token', tokenSecret: 'p:t' } });
  });

  it('rejects a pasted token instead of committing it to the repository', () => {
    expect(() =>
      job('build', {
        container: {
          image: 'ghcr.io/acme/ci:1.2',
          auth: { tokenSecret: 'ghp_0123456789abcdefghij' },
        },
        runsOn: ['kici:os:linux'],
        steps: [step('noop', { run: async () => {} })],
      }),
    ).toThrow(/looks like the credential itself/i);
  });

  it('rejects an unqualified secret reference', () => {
    expect(() =>
      job('build', {
        container: { image: 'ghcr.io/acme/ci:1.2', auth: { tokenSecret: 'no-context' } },
        runsOn: ['kici:os:linux'],
        steps: [step('noop', { run: async () => {} })],
      }),
    ).toThrow(/qualified/i);
  });

  it('leaves a container with no auth untouched', () => {
    const j = job('build', {
      container: { image: 'python:3.12-slim' },
      runsOn: ['kici:os:linux'],
      steps: [step('noop', { run: async () => {} })],
    });
    expect(j.container).toEqual({ image: 'python:3.12-slim' });
  });
});

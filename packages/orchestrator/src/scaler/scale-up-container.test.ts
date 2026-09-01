import { describe, it, expect } from 'vitest';
import type { SpawnContext, ResolvedContainerSpawn } from './types.js';

/**
 * `SpawnContext.container` is how a job's own image reaches a backend. The
 * manager threads it verbatim; these assert the shape both ends agree on,
 * without standing up a manager (whose spawn path needs a backend, a
 * semaphore, a registry and a live config).
 */
describe('SpawnContext.container', () => {
  it('carries the image and the resolved registry credentials', () => {
    const container: ResolvedContainerSpawn = {
      image: 'reg.internal:5000/acme/ci:1.2',
      authconfig: { username: 'bot', password: 's3cr3t', serveraddress: 'reg.internal:5000' },
    };
    const ctx: SpawnContext = { boundJobId: 'job-1', runId: 'run-1', container };

    expect(ctx.container?.image).toBe('reg.internal:5000/acme/ci:1.2');
    expect(ctx.container?.authconfig?.serveraddress).toBe('reg.internal:5000');
  });

  it('is absent for an ordinary spawn, which uses the pool image', () => {
    // Absence is the discriminator a backend branches on: no container means
    // "spawn the pool's fixed agent image", exactly as before this existed.
    const ctx: SpawnContext = { boundJobId: 'job-1', runId: 'run-1' };
    expect(ctx.container).toBeUndefined();
  });

  it('allows an image with no credentials — a public per-job image', () => {
    const ctx: SpawnContext = { container: { image: 'python:3.12-slim' } };
    expect(ctx.container?.image).toBe('python:3.12-slim');
    expect(ctx.container?.authconfig).toBeUndefined();
  });
});

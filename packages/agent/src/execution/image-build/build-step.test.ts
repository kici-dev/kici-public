import { describe, it, expect, vi } from 'vitest';
import {
  CONTAINER_BUILD_STEP_INDEX,
  CONTAINER_BUILD_STEP_NAME,
  runJobImageBuild,
} from './build-step.js';

describe('CONTAINER_BUILD_STEP_INDEX', () => {
  it('is non-negative, because step.status refuses a negative index', () => {
    expect(CONTAINER_BUILD_STEP_INDEX).toBeGreaterThanOrEqual(0);
  });

  it('clears the cache allocator ceiling for a several-hundred-step job', () => {
    // cacheBase = stepCount * 3 + 100, then a 1000-index block per owner
    // (every step, plus the job-level owner).
    const stepCount = 500;
    const cacheCeiling = stepCount * 3 + 100 + (stepCount + 1) * 1000;
    expect(CONTAINER_BUILD_STEP_INDEX).toBeGreaterThan(cacheCeiling);
  });
});

function deps() {
  return {
    build: vi.fn().mockResolvedValue(undefined),
    onLog: vi.fn(),
    sendStepStatus: vi.fn(),
    fileExists: () => true,
  };
}

const base = { workDir: '/w', jobId: 'j', jobName: 'build' };

describe('runJobImageBuild', () => {
  it('does nothing, and emits no step, for a job with no container', async () => {
    const d = deps();
    expect(await runJobImageBuild({ ...base, container: undefined, ...d })).toBeUndefined();
    expect(d.build).not.toHaveBeenCalled();
    // A run timeline should not grow an empty entry for work that did not happen.
    expect(d.sendStepStatus).not.toHaveBeenCalled();
  });

  it('does nothing for a job that names a finalized image', async () => {
    const d = deps();
    expect(
      await runJobImageBuild({ ...base, container: { image: 'python:3.12' }, ...d }),
    ).toBeUndefined();
    expect(d.build).not.toHaveBeenCalled();
    expect(d.sendStepStatus).not.toHaveBeenCalled();
  });

  it('reports running then success, and returns the tag the sandbox must run', async () => {
    const d = deps();
    const tag = await runJobImageBuild({ ...base, container: { dockerfile: 'Dockerfile' }, ...d });
    expect(tag).toBe('kici-build:build-j');
    expect(d.sendStepStatus.mock.calls.map((c) => c[1])).toEqual(['running', 'success']);
    expect(d.sendStepStatus.mock.calls[0][0]).toBe(CONTAINER_BUILD_STEP_NAME);
  });

  it('hands the resolved spec to the builder', async () => {
    const d = deps();
    await runJobImageBuild({
      ...base,
      container: { dockerfile: '.kici/ci.Dockerfile', target: 'ci' },
      ...d,
    });
    const spec = d.build.mock.calls[0][0];
    expect(spec.dockerfilePath).toBe('/w/.kici/ci.Dockerfile');
    expect(spec.target).toBe('ci');
  });

  it('reports failed and rethrows, carrying the builder’s own words', async () => {
    const d = deps();
    d.build.mockRejectedValue(new Error("'docker build' failed: RUN apt-get exit 100"));
    await expect(
      runJobImageBuild({ ...base, container: { dockerfile: 'Dockerfile' }, ...d }),
    ).rejects.toThrow(/exit 100/);
    expect(d.sendStepStatus.mock.calls.map((c) => c[1])).toEqual(['running', 'failed']);
    expect(d.sendStepStatus.mock.calls[1][2]).toMatchObject({
      error: expect.stringMatching(/100/),
    });
  });

  it('logs the failure into the run log too, not only the step data', async () => {
    // The author reads the run log; a reason that only exists in step metadata
    // is a reason they will not see.
    const d = deps();
    d.build.mockRejectedValue(new Error('boom'));
    await expect(
      runJobImageBuild({ ...base, container: { dockerfile: 'Dockerfile' }, ...d }),
    ).rejects.toThrow();
    expect(d.onLog.mock.calls.flat().join('\n')).toMatch(/Build failed: boom/);
  });

  it('propagates a spec-resolution refusal without emitting a step', async () => {
    const d = deps();
    await expect(
      runJobImageBuild({ ...base, container: { dockerfile: '../escape' }, ...d }),
    ).rejects.toThrow(/must stay inside the repository/);
    expect(d.sendStepStatus).not.toHaveBeenCalled();
  });
});

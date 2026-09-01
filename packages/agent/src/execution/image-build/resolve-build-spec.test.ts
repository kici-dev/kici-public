import { describe, it, expect } from 'vitest';
import { resolveJobImageBuildSpec } from './resolve-build-spec.js';

const base = {
  workDir: '/work/job',
  jobId: 'job-1',
  jobName: 'build',
  fileExists: () => true,
};

describe('resolveJobImageBuildSpec', () => {
  it('builds nothing for a job with no container', () => {
    expect(resolveJobImageBuildSpec({ ...base, container: undefined })).toBeUndefined();
  });

  it('builds nothing for a job that names a finalized image', () => {
    expect(resolveJobImageBuildSpec({ ...base, container: 'python:3.12' })).toBeUndefined();
    expect(
      resolveJobImageBuildSpec({ ...base, container: { image: 'python:3.12' } }),
    ).toBeUndefined();
  });

  it('anchors the dockerfile and the context under the workdir', () => {
    const spec = resolveJobImageBuildSpec({
      ...base,
      container: { dockerfile: '.kici/ci.Dockerfile', context: 'sub' },
    });
    expect(spec?.dockerfilePath).toBe('/work/job/.kici/ci.Dockerfile');
    expect(spec?.contextDir).toBe('/work/job/sub');
  });

  it('defaults the context to the repository root', () => {
    const spec = resolveJobImageBuildSpec({ ...base, container: { dockerfile: 'Dockerfile' } });
    expect(spec?.contextDir).toBe('/work/job');
  });

  it('refuses a dockerfile path that escapes the workdir', () => {
    // The SDK already refused this. Refusing it again is the point: a lock file
    // is repo content, so a hand-edited lock must not reach outside the tree.
    expect(() =>
      resolveJobImageBuildSpec({ ...base, container: { dockerfile: '../../etc/shadow' } }),
    ).toThrow(/must stay inside the repository/);
  });

  it('refuses an absolute dockerfile path', () => {
    expect(() =>
      resolveJobImageBuildSpec({ ...base, container: { dockerfile: '/etc/shadow' } }),
    ).toThrow(/must stay inside the repository/);
  });

  it('refuses a path that escapes and returns, since it left the tree on the way', () => {
    expect(() =>
      resolveJobImageBuildSpec({
        ...base,
        container: { dockerfile: '../job-other/../../etc/shadow' },
      }),
    ).toThrow(/must stay inside the repository/);
  });

  it('refuses a context that escapes the workdir', () => {
    expect(() =>
      resolveJobImageBuildSpec({
        ...base,
        container: { dockerfile: 'Dockerfile', context: '../..' },
      }),
    ).toThrow(/container.context must stay inside the repository/);
  });

  it('names the resolved path when the dockerfile is not there', () => {
    expect(() =>
      resolveJobImageBuildSpec({
        ...base,
        container: { dockerfile: 'missing.Dockerfile' },
        fileExists: () => false,
      }),
    ).toThrow(/missing\.Dockerfile.*\/work\/job\/missing\.Dockerfile/s);
  });

  it('carries target, args, tag and labels', () => {
    const spec = resolveJobImageBuildSpec({
      ...base,
      container: { dockerfile: 'Dockerfile', target: 'ci', args: { A: '1' } },
    });
    expect(spec?.target).toBe('ci');
    expect(spec?.args).toEqual({ A: '1' });
    expect(spec?.tag).toBe('kici-build:build-job-1');
    // The labels are what put the image in reach of the host leak sweep.
    expect(spec?.labels).toEqual({ 'kici-managed': 'true', 'kici-job-id': 'job-1' });
  });

  it('omits target when the job named no stage', () => {
    const spec = resolveJobImageBuildSpec({ ...base, container: { dockerfile: 'Dockerfile' } });
    expect(spec).not.toHaveProperty('target');
  });

  it('copies args rather than aliasing the lock', () => {
    const container = { dockerfile: 'Dockerfile', args: { A: '1' } };
    const spec = resolveJobImageBuildSpec({ ...base, container });
    spec!.args.B = '2';
    expect(container.args).toEqual({ A: '1' });
  });

  it('reduces a job name that is not tag-safe', () => {
    const spec = resolveJobImageBuildSpec({
      ...base,
      jobName: 'Build/Thing (x)',
      container: { dockerfile: 'Dockerfile' },
    });
    expect(spec?.tag).toMatch(/^kici-build:[A-Za-z0-9_.-]+$/);
  });

  it('never produces an empty tag component', () => {
    const spec = resolveJobImageBuildSpec({
      ...base,
      jobName: '///',
      container: { dockerfile: 'Dockerfile' },
    });
    expect(spec?.tag).toBe('kici-build:job-job-1');
  });

  it('gives two matrix legs of one job DIFFERENT tags', () => {
    // The names share a long prefix and differ only in the suffix, so a
    // name-only tag truncates them to the same string. Two legs of one run on
    // one host would then race for one tag, and a leg could run its sibling's
    // image.
    const long = 'build-the-whole-world-with-every-toolchain-we-support';
    const linux = resolveJobImageBuildSpec({
      ...base,
      jobId: 'job-linux',
      jobName: `${long} (os=linux)`,
      container: { dockerfile: 'Dockerfile' },
    });
    const darwin = resolveJobImageBuildSpec({
      ...base,
      jobId: 'job-darwin',
      jobName: `${long} (os=darwin)`,
      container: { dockerfile: 'Dockerfile' },
    });
    expect(linux?.tag).not.toBe(darwin?.tag);
  });

  it('keeps the tag within what a container runtime accepts', () => {
    const spec = resolveJobImageBuildSpec({
      ...base,
      jobId: 'a'.repeat(64),
      jobName: 'x'.repeat(200),
      container: { dockerfile: 'Dockerfile' },
    });
    const tag = spec!.tag.slice('kici-build:'.length);
    // Docker caps a tag at 128 chars and allows [A-Za-z0-9_.-].
    expect(tag.length).toBeLessThanOrEqual(128);
    expect(tag).toMatch(/^[A-Za-z0-9_][A-Za-z0-9_.-]*$/);
  });
});

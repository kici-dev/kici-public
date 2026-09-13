import { describe, it, expect, vi } from 'vitest';
import { classifyImageLibc, assertImageRunnable, PROBE_PATHS } from './image-preflight.js';

describe('classifyImageLibc', () => {
  it.each([
    [['/lib64/ld-linux-x86-64.so.2', '/bin/sh'], 'glibc'],
    [['/lib/ld-linux-aarch64.so.1', '/bin/sh'], 'glibc'],
    [['/lib/ld-musl-x86_64.so.1', '/bin/sh'], 'musl'],
    [['/lib/ld-musl-aarch64.so.1', '/bin/sh'], 'musl'],
    [['/bin/sh'], 'static'],
    [['/lib64/ld-linux-x86-64.so.2'], 'no-shell'],
    [[], 'static'],
  ])('%j → %s', (paths, expected) => {
    expect(classifyImageLibc(paths)).toBe(expected);
  });

  it('reports musl even when a glibc loader is also present', () => {
    // A mixed rootfs still runs the musl loader for musl-linked binaries, so
    // calling it glibc would let an unsupported image through.
    expect(
      classifyImageLibc(['/lib64/ld-linux-x86-64.so.2', '/lib/ld-musl-x86_64.so.1', '/bin/sh']),
    ).toBe('musl');
  });
});

/** A dockerode double whose container reports only `present` paths as existing. */
function dockerWith(present: string[]) {
  const remove = vi.fn().mockResolvedValue(undefined);
  const infoArchive = vi.fn(async ({ path }: { path: string }) => {
    if (present.includes(path)) return { name: path };
    throw Object.assign(new Error('not found'), { statusCode: 404 });
  });
  const createContainer = vi.fn().mockResolvedValue({ infoArchive, remove });
  return { docker: { createContainer } as never, createContainer, remove };
}

describe('assertImageRunnable', () => {
  it('accepts a glibc image with a shell', async () => {
    const { docker, remove } = dockerWith(['/lib64/ld-linux-x86-64.so.2', '/bin/sh']);
    await expect(assertImageRunnable(docker, 'python:3.12-slim')).resolves.toBeUndefined();
    // The probe container is scratch — it must never be left behind.
    expect(remove).toHaveBeenCalled();
  });

  it('rejects a musl image, naming it and the reason', async () => {
    const { docker } = dockerWith(['/lib/ld-musl-x86_64.so.1', '/bin/sh']);
    await expect(assertImageRunnable(docker, 'alpine:3.20')).rejects.toThrow(
      /alpine:3\.20.*musl/is,
    );
  });

  it('rejects a static image with no dynamic loader', async () => {
    const { docker } = dockerWith(['/bin/sh']);
    await expect(assertImageRunnable(docker, 'scratchy:1')).rejects.toThrow(/no dynamic loader/i);
  });

  it('rejects a shell-less image', async () => {
    const { docker } = dockerWith(['/lib64/ld-linux-x86-64.so.2']);
    await expect(assertImageRunnable(docker, 'distroless:1')).rejects.toThrow(/no \/bin\/sh/i);
  });

  it('removes the probe container even when the image is rejected', async () => {
    const { docker, remove } = dockerWith(['/lib/ld-musl-x86_64.so.1', '/bin/sh']);
    await expect(assertImageRunnable(docker, 'alpine:3.20')).rejects.toThrow();
    expect(remove).toHaveBeenCalled();
  });

  it('probes every loader it knows about plus the shell', async () => {
    const { docker, createContainer } = dockerWith(['/lib64/ld-linux-x86-64.so.2', '/bin/sh']);
    await assertImageRunnable(docker, 'python:3.12-slim');
    expect(PROBE_PATHS).toContain('/bin/sh');
    expect(PROBE_PATHS).toContain('/lib/ld-musl-x86_64.so.1');
    // The probe must never start the container — a shell-less or musl image
    // cannot run anything, and starting one would be a second failure mode.
    expect(createContainer).toHaveBeenCalledTimes(1);
  });
});

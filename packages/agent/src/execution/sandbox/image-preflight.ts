/**
 * Fail a container job on an unusable image BEFORE it starts. The injected
 * runtime (pinned glibc-2.17 Node) needs only a glibc and a shell; without them
 * the runtime's own error is useless — a musl image reports
 *
 *   exec container process (missing dynamic library?) `/opt/kici/node/bin/node`:
 *   No such file or directory
 *
 * naming a file that exists. glibc-only is deliberate; a musl runtime variant is
 * a documented follow-up.
 */

import type Docker from 'dockerode';

export type ImageLibc = 'glibc' | 'musl' | 'static' | 'no-shell';

/** musl loaders on every architecture we publish for. */
const MUSL_LOADERS = ['/lib/ld-musl-x86_64.so.1', '/lib/ld-musl-aarch64.so.1'] as const;

/** glibc loaders on every architecture we publish for. */
const GLIBC_LOADERS = ['/lib64/ld-linux-x86-64.so.2', '/lib/ld-linux-aarch64.so.1'] as const;

const SHELL = '/bin/sh';

export const PROBE_PATHS: readonly string[] = [...GLIBC_LOADERS, ...MUSL_LOADERS, SHELL];

/**
 * Classify from the {@link PROBE_PATHS} present in the image. Pure, so the
 * decision table tests without a container runtime.
 */
export function classifyImageLibc(presentPaths: readonly string[]): ImageLibc {
  const present = new Set(presentPaths);
  const hasMusl = MUSL_LOADERS.some((p) => present.has(p));
  const hasGlibc = GLIBC_LOADERS.some((p) => present.has(p));

  // A mixed rootfs still runs the musl loader for musl-linked binaries, so musl
  // wins over glibc — calling it glibc would let an unsupported image through.
  if (hasMusl) return 'musl';
  if (!hasGlibc) return 'static';
  return present.has(SHELL) ? 'glibc' : 'no-shell';
}

function rejection(image: string, libc: Exclude<ImageLibc, 'glibc'>): string {
  switch (libc) {
    case 'musl':
      return (
        `image '${image}' uses musl libc; the musl runtime variant is not ` +
        `enabled (glibc images only in this version). Use a glibc image — ` +
        `for example the '-slim' rather than the '-alpine' tag.`
      );
    case 'static':
      return (
        `image '${image}' has no dynamic loader; container jobs require a ` +
        `glibc image with ${SHELL}.`
      );
    case 'no-shell':
      return `image '${image}' has no ${SHELL}; container jobs require a shell for step commands.`;
  }
}

/**
 * Throw unless `image` can host the injected runtime. Stats the probe paths in
 * a created-but-never-started container: running a probe command would fail for
 * the very reason under test.
 */
export async function assertImageRunnable(docker: Docker, image: string): Promise<void> {
  const container = await docker.createContainer({ Image: image });
  try {
    const present: string[] = [];
    for (const path of PROBE_PATHS) {
      try {
        await (
          container as unknown as { infoArchive(o: { path: string }): Promise<unknown> }
        ).infoArchive({ path });
        present.push(path);
      } catch {
        // A stat failure means absent.
      }
    }

    const libc = classifyImageLibc(present);
    if (libc !== 'glibc') throw new Error(rejection(image, libc));
  } finally {
    await (container as unknown as { remove(o?: unknown): Promise<unknown> })
      .remove({ force: true })
      .catch(() => undefined);
  }
}

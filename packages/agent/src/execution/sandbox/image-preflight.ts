/**
 * Fail a container job on an unusable image BEFORE the job starts.
 *
 * KiCI injects its own runtime (a pinned official glibc-2.17 Node) into the
 * customer's image, so the image needs only a glibc and a shell. When it has
 * neither, the container runtime's own error is close to useless — a musl image
 * reports
 *
 *   exec container process (missing dynamic library?) `/opt/kici/node/bin/node`:
 *   No such file or directory
 *
 * which names a file that plainly exists and says nothing about musl. The
 * preflight turns that into a sentence an author can act on, and it fires
 * before any step runs rather than partway through a job.
 *
 * glibc-only is the deliberate scope of this version; a musl runtime variant is
 * a documented follow-up.
 */

import type Docker from 'dockerode';

/** What an image's rootfs says about whether we can run our runtime in it. */
export type ImageLibc = 'glibc' | 'musl' | 'static' | 'no-shell';

/** Dynamic loaders that mean "musl", across the architectures we publish for. */
const MUSL_LOADERS = ['/lib/ld-musl-x86_64.so.1', '/lib/ld-musl-aarch64.so.1'] as const;

/** Dynamic loaders that mean "glibc", across the architectures we publish for. */
const GLIBC_LOADERS = ['/lib64/ld-linux-x86-64.so.2', '/lib/ld-linux-aarch64.so.1'] as const;

const SHELL = '/bin/sh';

/** Every path the preflight stats in the image. */
export const PROBE_PATHS: readonly string[] = [...GLIBC_LOADERS, ...MUSL_LOADERS, SHELL];

/**
 * Classify an image from the subset of {@link PROBE_PATHS} that exist in it.
 *
 * Pure, so the decision table is testable without a container runtime.
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
 * Throw unless `image` can host the injected runtime.
 *
 * Stats the probe paths through a created-but-never-started container, so a
 * shell-less or musl image is diagnosed without executing anything in it —
 * running a probe command would fail for the very reason we are testing for.
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
        // A stat failure means "absent" for our purposes; the classification
        // below turns the resulting set into the actionable message.
      }
    }

    const libc = classifyImageLibc(present);
    if (libc !== 'glibc') throw new Error(rejection(image, libc));
  } finally {
    // Scratch container — never leave it behind, including on the reject path.
    await (container as unknown as { remove(o?: unknown): Promise<unknown> })
      .remove({ force: true })
      .catch(() => undefined);
  }
}

/**
 * Pre-formatted ext4 templates for the per-VM overlay drive.
 *
 * Every Firecracker VM gets a writable overlay drive: a sparse file holding an
 * empty ext4 filesystem. Formatting it per spawn runs `mkfs.ext4`, which calls
 * `fsync` on the new file. On a host whose disk has a large write-back backlog
 * (a slow disk, or another tenant writing hundreds of MB) that `fsync` waits
 * behind the whole backlog, and a step that takes 86 ms on an idle disk takes
 * tens of seconds.
 *
 * So the filesystem is formatted once per drive size per host, into
 * `<chrootBaseDir>/firecracker/.overlay-templates/overlay-<MiB>mib.ext4`, and each spawn
 * copies it with `cp --sparse=always`. The copy writes only the allocated
 * blocks (about 2 MB for a 2 GiB drive) into the page cache and never calls
 * `fsync`, so its duration does not depend on the disk backlog.
 *
 * A template is reused only when its size matches and the ext4 superblock
 * magic is present; anything else is rebuilt. A build writes to a temporary
 * name and renames it into place, so a crash leaves no partial template and
 * two processes building the same size at once both leave a complete file.
 * Within one process, concurrent first uses share one build.
 */
import { randomUUID } from 'node:crypto';
import { mkdir, open, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { createLogger } from '@kici-dev/shared';

const logger = createLogger({ prefix: 'firecracker-overlay' });

/**
 * Directory that holds the templates, relative to the jailer chroot base dir.
 * It sits beside the per-VM chroots because the orchestrator must already be
 * able to create directories there; the leading dot keeps it out of the
 * orphan sweep, which reads every other entry as a VM id.
 */
export const OVERLAY_TEMPLATE_DIR = join('firecracker', '.overlay-templates');

/**
 * Timeout for formatting a template. It runs once per size per host, mostly
 * off a spawn's critical path, and its `fsync` may wait behind a disk backlog,
 * so it gets far more room than a per-spawn step.
 */
export const OVERLAY_TEMPLATE_MKFS_TIMEOUT_MS = 300_000;

/** Timeout for the per-spawn copy. */
export const OVERLAY_COPY_TIMEOUT_MS = 30_000;

const MIB = 1024 * 1024;
/** The ext4 superblock starts at byte 1024; `s_magic` is at offset 0x38 in it. */
const EXT4_MAGIC_OFFSET = 1024 + 0x38;
const EXT4_MAGIC = 0xef53;

/** Runs a host command, rejecting on failure. The backend passes its `execAsync`. */
export type OverlayCommandRunner = (
  cmd: string,
  args: string[],
  timeoutMs: number,
) => Promise<unknown>;

/** Where the template for a drive size lives. */
export function overlayTemplatePath(chrootBaseDir: string, sizeMib: number): string {
  return join(chrootBaseDir, OVERLAY_TEMPLATE_DIR, `overlay-${sizeMib}mib.ext4`);
}

/**
 * Whether `path` is a usable template for `sizeMib`: it exists, its size is
 * exactly `sizeMib` MiB, and it carries the ext4 superblock magic.
 */
export async function isOverlayTemplate(path: string, sizeMib: number): Promise<boolean> {
  let fd;
  try {
    fd = await open(path, 'r');
  } catch {
    return false;
  }
  try {
    const { size } = await fd.stat();
    if (size !== sizeMib * MIB) return false;
    const buf = Buffer.alloc(2);
    const { bytesRead } = await fd.read(buf, 0, 2, EXT4_MAGIC_OFFSET);
    return bytesRead === 2 && buf.readUInt16LE(0) === EXT4_MAGIC;
  } finally {
    await fd.close();
  }
}

/** Builds and hands out overlay templates for one jailer chroot base dir. */
export class OverlayTemplates {
  /** In-flight builds by size, so concurrent first uses share one build. */
  private readonly builds = new Map<number, Promise<void>>();

  constructor(
    private readonly chrootBaseDir: string,
    private readonly run: OverlayCommandRunner,
  ) {}

  /** Return the path of a valid template for `sizeMib`, building it if needed. */
  async ensure(sizeMib: number): Promise<string> {
    const path = overlayTemplatePath(this.chrootBaseDir, sizeMib);
    const inFlight = this.builds.get(sizeMib);
    if (inFlight) await inFlight;
    if (await isOverlayTemplate(path, sizeMib)) return path;

    let build = this.builds.get(sizeMib);
    if (!build) {
      build = this.build(path, sizeMib).finally(() => this.builds.delete(sizeMib));
      this.builds.set(sizeMib, build);
    }
    await build;
    return path;
  }

  /** Create the overlay drive at `dest` as a sparse copy of the template. */
  async createOverlay(dest: string, sizeMib: number): Promise<void> {
    const template = await this.ensure(sizeMib);
    await this.run(
      'cp',
      ['--reflink=auto', '--sparse=always', template, dest],
      OVERLAY_COPY_TIMEOUT_MS,
    );
  }

  private async build(path: string, sizeMib: number): Promise<void> {
    await mkdir(join(this.chrootBaseDir, OVERLAY_TEMPLATE_DIR), { recursive: true });
    const tmp = `${path}.tmp-${process.pid}-${randomUUID().slice(0, 8)}`;
    const startedAt = Date.now();
    try {
      const fd = await open(tmp, 'w');
      try {
        await fd.truncate(sizeMib * MIB);
      } finally {
        await fd.close();
      }
      await this.run('mkfs.ext4', ['-qF', tmp], OVERLAY_TEMPLATE_MKFS_TIMEOUT_MS);
      if (!(await isOverlayTemplate(tmp, sizeMib))) {
        throw new Error(`mkfs.ext4 left no ext4 filesystem of ${sizeMib} MiB in ${tmp}`);
      }
      await rename(tmp, path);
    } catch (err) {
      await rm(tmp, { force: true }).catch(() => {});
      throw err;
    }
    logger.info(
      `Formatted overlay template ${path} (${sizeMib} MiB) in ${Date.now() - startedAt} ms`,
    );
  }
}

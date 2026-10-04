import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFile } from 'node:child_process';
import { accessSync, constants } from 'node:fs';
import { copyFile, mkdir, mkdtemp, open, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { promisify } from 'node:util';
import {
  OVERLAY_TEMPLATE_DIR,
  OVERLAY_TEMPLATE_MKFS_TIMEOUT_MS,
  OverlayTemplates,
  isOverlayTemplate,
  overlayTemplatePath,
  type OverlayCommandRunner,
} from './overlay-template.js';

const execFileAsync = promisify(execFile);
const MIB = 1024 * 1024;

/** mkfs.ext4 and e2fsck live in /usr/sbin, which a login user's PATH often omits. */
const SBIN_PATH = [process.env.PATH, '/usr/sbin', '/sbin'].filter(Boolean).join(delimiter);

/** The first executable named `name` on `searchPath`, or null when there is none. */
function findExecutable(name: string, searchPath: string): string | null {
  for (const dir of searchPath.split(delimiter)) {
    if (!dir) continue;
    const candidate = join(dir, name);
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Not in this directory: try the next one.
    }
  }
  return null;
}

/** The e2fsprogs tools the real-filesystem case runs; null on a host without e2fsprogs. */
const MKFS_EXT4 = findExecutable('mkfs.ext4', SBIN_PATH);
const E2FSCK = findExecutable('e2fsck', SBIN_PATH);
/** `s_magic` of an ext4 superblock, as `mkfs.ext4` writes it. */
const EXT4_MAGIC_OFFSET = 1024 + 0x38;

/** Write the ext4 superblock magic into `path`, as a fake `mkfs.ext4`. */
async function writeExt4Magic(path: string): Promise<void> {
  const fd = await open(path, 'r+');
  try {
    await fd.write(Buffer.from([0x53, 0xef]), 0, 2, EXT4_MAGIC_OFFSET);
  } finally {
    await fd.close();
  }
}

/**
 * A command runner that records every call. `mkfs.ext4` writes the magic
 * after `mkfsDelayMs` (so concurrent callers overlap the build); `cp` copies.
 */
function recordingRunner(opts: { mkfsDelayMs?: number; mkfsFails?: boolean } = {}) {
  const calls: Array<{ cmd: string; args: string[]; timeoutMs: number }> = [];
  const run: OverlayCommandRunner = async (cmd, args, timeoutMs) => {
    calls.push({ cmd, args, timeoutMs });
    if (cmd === 'mkfs.ext4') {
      await new Promise((r) => setTimeout(r, opts.mkfsDelayMs ?? 0));
      if (opts.mkfsFails) throw new Error('mkfs.ext4 timed out');
      await writeExt4Magic(args[1]!);
      return;
    }
    if (cmd === 'cp') {
      await copyFile(args[args.length - 2]!, args[args.length - 1]!);
      return;
    }
    throw new Error(`unexpected command ${cmd}`);
  };
  return { run, calls, mkfsCalls: () => calls.filter((c) => c.cmd === 'mkfs.ext4') };
}

describe('OverlayTemplates', () => {
  let base: string;

  beforeEach(async () => {
    base = await mkdtemp(join(tmpdir(), 'kici-overlay-template-'));
  });

  afterEach(async () => {
    await rm(base, { recursive: true, force: true });
  });

  it('builds one template for concurrent first uses of a size', async () => {
    const runner = recordingRunner({ mkfsDelayMs: 50 });
    const templates = new OverlayTemplates(base, runner.run);

    const paths = await Promise.all(Array.from({ length: 5 }, () => templates.ensure(16)));

    // fails-when: each concurrent first use formats its own template.
    expect(runner.mkfsCalls()).toHaveLength(1);
    expect(new Set(paths)).toEqual(new Set([overlayTemplatePath(base, 16)]));
    expect(await isOverlayTemplate(paths[0]!, 16)).toBe(true);
    // The build ran under its own long timeout, not the per-spawn one.
    expect(runner.mkfsCalls()[0]!.timeoutMs).toBe(OVERLAY_TEMPLATE_MKFS_TIMEOUT_MS);
    // No temporary build file is left beside the template.
    expect(await readdir(join(base, OVERLAY_TEMPLATE_DIR))).toEqual(['overlay-16mib.ext4']);
  });

  it('never formats on the per-spawn path once the template exists', async () => {
    const runner = recordingRunner();
    const templates = new OverlayTemplates(base, runner.run);
    await templates.ensure(16);
    runner.calls.length = 0;

    for (const id of ['a', 'b', 'c']) {
      await templates.createOverlay(join(base, `overlay-${id}.ext4`), 16);
    }

    // fails-when: a spawn runs mkfs.ext4, whose fsync waits behind the disk's backlog.
    expect(runner.mkfsCalls()).toEqual([]);
    expect(runner.calls.map((c) => c.cmd)).toEqual(['cp', 'cp', 'cp']);
    expect(runner.calls[0]!.args.slice(0, 2)).toEqual(['--reflink=auto', '--sparse=always']);
    expect(await isOverlayTemplate(join(base, 'overlay-a.ext4'), 16)).toBe(true);
  });

  it('keeps one template per size', async () => {
    const runner = recordingRunner();
    const templates = new OverlayTemplates(base, runner.run);

    await templates.createOverlay(join(base, 'small.ext4'), 16);
    await templates.createOverlay(join(base, 'large.ext4'), 32);

    expect(runner.mkfsCalls()).toHaveLength(2);
    expect((await stat(join(base, 'small.ext4'))).size).toBe(16 * MIB);
    expect((await stat(join(base, 'large.ext4'))).size).toBe(32 * MIB);
  });

  it('rebuilds a template of the wrong size instead of reusing it', async () => {
    const runner = recordingRunner();
    const path = overlayTemplatePath(base, 16);
    await mkdir(join(base, OVERLAY_TEMPLATE_DIR), { recursive: true });
    // A valid ext4 magic at the wrong size: e.g. the file of another size, or
    // one cut short.
    await writeFile(path, Buffer.alloc(8 * MIB));
    await writeExt4Magic(path);

    const templates = new OverlayTemplates(base, runner.run);
    await templates.ensure(16);

    // fails-when: the template is trusted by name and an 8 MiB drive is handed
    // to a VM configured for 16 MiB.
    expect(runner.mkfsCalls()).toHaveLength(1);
    expect((await stat(path)).size).toBe(16 * MIB);
  });

  it('rebuilds a template that holds no ext4 filesystem', async () => {
    const runner = recordingRunner();
    const path = overlayTemplatePath(base, 16);
    await mkdir(join(base, OVERLAY_TEMPLATE_DIR), { recursive: true });
    await writeFile(path, Buffer.alloc(16 * MIB));

    await new OverlayTemplates(base, runner.run).ensure(16);

    expect(runner.mkfsCalls()).toHaveLength(1);
    expect(await isOverlayTemplate(path, 16)).toBe(true);
  });

  it('reuses a valid template another process built', async () => {
    const first = recordingRunner();
    await new OverlayTemplates(base, first.run).ensure(16);

    const second = recordingRunner();
    await new OverlayTemplates(base, second.run).ensure(16);

    // breaks-if-wrong: a restart must not reformat a template that is fine.
    expect(second.mkfsCalls()).toEqual([]);
  });

  it('leaves a complete template when two processes build at once', async () => {
    const a = recordingRunner({ mkfsDelayMs: 30 });
    const b = recordingRunner({ mkfsDelayMs: 30 });

    await Promise.all([
      new OverlayTemplates(base, a.run).ensure(16),
      new OverlayTemplates(base, b.run).ensure(16),
    ]);

    expect(await isOverlayTemplate(overlayTemplatePath(base, 16), 16)).toBe(true);
    expect(await readdir(join(base, OVERLAY_TEMPLATE_DIR))).toEqual(['overlay-16mib.ext4']);
  });

  it('leaves no template or temporary file when the build fails, and retries next time', async () => {
    const failing = recordingRunner({ mkfsFails: true });
    const templates = new OverlayTemplates(base, failing.run);

    await expect(templates.ensure(16)).rejects.toThrow('mkfs.ext4 timed out');
    expect(await readdir(join(base, OVERLAY_TEMPLATE_DIR))).toEqual([]);

    const working = recordingRunner();
    await new OverlayTemplates(base, working.run).ensure(16);
    expect(await isOverlayTemplate(overlayTemplatePath(base, 16), 16)).toBe(true);
  });

  // Skipped on a host without e2fsprogs, such as a minimal container: this case
  // needs the real mkfs.ext4 and e2fsck. The recording-runner cases above cover
  // the template logic on every host.
  // breaks-if-wrong: on a host with e2fsprogs (a Debian workstation, GitHub's ubuntu
  // runner) the case runs, and the verbose reporter shows it passed.
  it.skipIf(!MKFS_EXT4 || !E2FSCK)(
    'builds a real ext4 template with mkfs.ext4 and copies it sparsely with cp',
    async () => {
      // The real tools, so the magic offset, the size check and the cp flags are
      // checked against what mkfs.ext4 and GNU cp actually do.
      const env = { ...process.env, PATH: SBIN_PATH };
      const run: OverlayCommandRunner = async (cmd, args, timeoutMs) =>
        execFileAsync(cmd, args, { timeout: timeoutMs, env });
      const templates = new OverlayTemplates(base, run);
      const dest = join(base, 'overlay.ext4');

      await templates.createOverlay(dest, 64);

      expect(await isOverlayTemplate(dest, 64)).toBe(true);
      // Sparse: a 64 MiB drive allocates a small fraction of its size.
      const { blocks, size } = await stat(dest);
      expect(size).toBe(64 * MIB);
      expect(blocks * 512).toBeLessThan(size / 4);
      // The copy is a valid filesystem, not just the right first bytes.
      await execFileAsync(E2FSCK!, ['-fn', dest]);
    },
  );
});

describe('isOverlayTemplate', () => {
  it('is false for a missing file', async () => {
    expect(await isOverlayTemplate('/nonexistent/overlay.ext4', 16)).toBe(false);
  });
});

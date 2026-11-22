import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import { create as tarCreate, replace as tarReplace } from 'tar';
import { extractOverlay, readExtractedRegularFile } from './overlay-extract.js';

const onWindows = process.platform === 'win32';

describe('extractOverlay', () => {
  let tmp: string;
  let out: string;

  beforeEach(async () => {
    tmp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'kici-overlay-extract-')));
    out = path.join(tmp, 'out');
    await fs.mkdir(out);
  });

  afterEach(async () => {
    await fs.rm(tmp, { recursive: true, force: true });
  });

  /** A gzipped tarball of `entries` read from `stage`, in that order. */
  async function tarball(stage: string, entries: string[]): Promise<Buffer> {
    const file = path.join(tmp, `t-${entries.join('-').replace(/\W/g, '_')}.tar`);
    await tarCreate({ file, cwd: stage }, entries);
    return gzipSync(await fs.readFile(file));
  }

  let stageCount = 0;

  /**
   * A gzipped tarball built from successive stages, each a fresh directory
   * `build` fills and whose `entries` are appended in order. Lets one tarball
   * carry several entries at the same path.
   */
  async function stagedTarball(
    stages: Array<[(dir: string) => Promise<unknown>, string[]]>,
  ): Promise<Buffer> {
    const file = path.join(tmp, `staged-${stageCount}.tar`);
    for (const [index, [build, entries]] of stages.entries()) {
      const dir = path.join(tmp, `stage-${stageCount++}`);
      await fs.mkdir(dir);
      await build(dir);
      await (index === 0 ? tarCreate : tarReplace)({ file, cwd: dir }, entries);
    }
    return gzipSync(await fs.readFile(file));
  }

  /** One stage holding the symlink `name -> text`. */
  const linkStage = (name: string, text: string): [(dir: string) => Promise<void>, string[]] => [
    async (dir) => {
      await fs.mkdir(path.dirname(path.join(dir, name)), { recursive: true });
      await fs.symlink(text, path.join(dir, name));
    },
    [name],
  ];

  /** One stage holding the regular file `name` with `content`. */
  const fileStage = (name: string, content: string): [(dir: string) => Promise<void>, string[]] => [
    async (dir) => {
      await fs.mkdir(path.dirname(path.join(dir, name)), { recursive: true });
      await fs.writeFile(path.join(dir, name), content);
    },
    [name],
  ];

  /** A stage holding `docs/b.yaml`, `site/hop.yaml -> ../docs/b.yaml` and `site/alerts.yaml -> hop.yaml`. */
  async function chainStage(): Promise<string> {
    const stage = path.join(tmp, 'stage');
    await fs.mkdir(path.join(stage, 'docs'), { recursive: true });
    await fs.mkdir(path.join(stage, 'site'));
    await fs.writeFile(path.join(stage, 'docs/b.yaml'), 'b');
    await fs.symlink('../docs/b.yaml', path.join(stage, 'site/hop.yaml'));
    await fs.symlink('hop.yaml', path.join(stage, 'site/alerts.yaml'));
    return stage;
  }

  it.each([
    ['the dependent link first', ['site/alerts.yaml', 'site/hop.yaml']],
    ['the target link first', ['site/hop.yaml', 'site/alerts.yaml']],
  ])('extracts a chain of links with %s', async (_order, links) => {
    const data = await tarball(await chainStage(), ['docs/b.yaml', ...links]);

    const { skippedLinks } = await extractOverlay(data, out);

    // fails-when: node-tar's own symlink extraction drops `alerts.yaml` when `hop.yaml` came first
    expect(await fs.readlink(path.join(out, 'site/alerts.yaml'))).toBe('hop.yaml');
    // breaks-if-wrong: an in-root text climbing from a nested link (`../docs/b.yaml`) is still placed
    expect(await fs.readlink(path.join(out, 'site/hop.yaml'))).toBe('../docs/b.yaml');
    expect(await fs.readFile(path.join(out, 'site/alerts.yaml'), 'utf8')).toBe('b');
    expect(skippedLinks).toEqual([]);
  });

  it('never writes a link entry through an earlier link entry', async () => {
    // `b -> .` resolves to the root, so `c -> b/..` is lexically inside but
    // resolves to the root's parent. Written through `c`, `c/x` would land
    // beside the extraction directory.
    const data = await stagedTarball([
      linkStage('b', '.'),
      linkStage('c', 'b/..'),
      linkStage('c/x', 'y'),
    ]);

    const { skippedLinks } = await extractOverlay(data, out);

    // fails-when: the parent directories of a link entry are not checked for symlinks
    expect(await fs.readdir(tmp)).not.toContain('x');
    expect(skippedLinks).toContainEqual({
      path: 'c/x',
      reason: 'a directory above it is a symlink or a file',
    });
    // breaks-if-wrong: the first link entry itself is still extracted
    expect(await fs.readlink(path.join(out, 'b'))).toBe('.');
  });

  describe('link text confinement', () => {
    let secret: string;

    beforeEach(async () => {
      secret = path.join(tmp, 'host-secret.txt');
      await fs.writeFile(secret, 'HOSTSECRET');
    });

    it('refuses an absolute link text', async () => {
      const data = await stagedTarball([linkStage('.kici-overlay-tmp/manifest.json', secret)]);

      const { skippedLinks } = await extractOverlay(data, out);

      // fails-when: link texts are written unconfined (the link would read the host file)
      await expect(fs.lstat(path.join(out, '.kici-overlay-tmp/manifest.json'))).rejects.toThrow();
      expect(skippedLinks).toEqual([
        { path: '.kici-overlay-tmp/manifest.json', reason: 'the link text is absolute' },
      ]);
    });

    it('refuses a link text that climbs out of the extraction directory', async () => {
      const climb = path.relative(path.join(out, '.kici-overlay-tmp'), secret);
      expect(climb.startsWith('..')).toBe(true);
      const data = await stagedTarball([linkStage('.kici-overlay-tmp/manifest.json', climb)]);

      const { skippedLinks } = await extractOverlay(data, out);

      // fails-when: a `../` text is checked only for `..` at its start, or not at all
      await expect(fs.lstat(path.join(out, '.kici-overlay-tmp/manifest.json'))).rejects.toThrow();
      expect(skippedLinks.map((s) => s.reason)).toEqual([
        'the link text leaves the extraction directory',
      ]);
    });

    it('refuses a directory link to a host directory', async () => {
      const data = await stagedTarball([linkStage('.kici-overlay-tmp', tmp)]);

      await extractOverlay(data, out);

      await expect(fs.lstat(path.join(out, '.kici-overlay-tmp'))).rejects.toThrow();
    });

    it('removes a link that is lexically inside but escapes through another link', async () => {
      // `a -> b/../host-secret.txt` normalizes to `host-secret.txt`, inside the
      // root, but `b -> .` makes the kernel climb to the root's parent.
      const data = await stagedTarball([
        linkStage('b', '.'),
        linkStage('a', 'b/../host-secret.txt'),
      ]);

      const { skippedLinks } = await extractOverlay(data, out);

      // fails-when: only node-tar's lexical rule runs, so `a` reads the host file
      await expect(fs.lstat(path.join(out, 'a'))).rejects.toThrow();
      expect(skippedLinks).toEqual([
        { path: 'a', reason: 'the link resolves outside the extraction directory' },
      ]);
      // breaks-if-wrong: a link resolving to the root itself stays
      expect(await fs.readlink(path.join(out, 'b'))).toBe('.');
    });

    it('keeps a link that reaches its file through an in-root directory link', async () => {
      const data = await stagedTarball([
        fileStage('docs/b.yaml', 'b'),
        linkStage('docs-link', 'docs'),
        linkStage('site/b.yaml', '../docs-link/b.yaml'),
      ]);

      const { skippedLinks } = await extractOverlay(data, out);

      // fails-when: the final-state check refuses a chain that never leaves the root
      expect(await fs.readFile(path.join(out, 'site/b.yaml'), 'utf8')).toBe('b');
      expect(skippedLinks).toEqual([]);
    });
  });

  describe('several entries at one path', () => {
    it('keeps the file when a regular file entry follows a link entry', async () => {
      const data = await stagedTarball([
        fileStage('one', '1'),
        linkStage('L', 'one'),
        fileStage('L', 'FILE'),
      ]);

      await extractOverlay(data, out);

      // fails-when: a set-aside link replaces the later file entry at its path
      const stat = await fs.lstat(path.join(out, 'L'));
      expect(stat.isFile()).toBe(true);
      expect(await fs.readFile(path.join(out, 'L'), 'utf8')).toBe('FILE');
    });

    it('keeps the last link when link, file and link entries share a path', async () => {
      const data = await stagedTarball([
        fileStage('one', '1'),
        fileStage('two', '2'),
        linkStage('L', 'one'),
        fileStage('L', 'FILE'),
        linkStage('L', 'two'),
      ]);

      await extractOverlay(data, out);

      // breaks-if-wrong: a link entry after a file entry still replaces the file
      expect(await fs.readlink(path.join(out, 'L'))).toBe('two');
    });
  });

  it.skipIf(onWindows)('keeps a backslash in a link entry name on POSIX', async () => {
    const data = await stagedTarball([fileStage('t', 't'), linkStage('a\\b', 't')]);

    await extractOverlay(data, out);

    // fails-when: `\` is read as a separator and the link lands at `a/b`
    expect(await fs.readlink(path.join(out, 'a\\b'))).toBe('t');
    await expect(fs.lstat(path.join(out, 'a'))).rejects.toThrow();
  });
});

describe('readExtractedRegularFile', () => {
  let root: string;

  beforeEach(async () => {
    root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'kici-overlay-read-')));
    await fs.mkdir(path.join(root, 'meta'));
    await fs.writeFile(path.join(root, 'meta/manifest.json'), '{"ok":true}');
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it('reads a regular file below real directories', async () => {
    // breaks-if-wrong: the plain case must still read
    const read = await readExtractedRegularFile(root, ['meta', 'manifest.json']);

    expect(read).toEqual({ data: Buffer.from('{"ok":true}') });
  });

  it('reports a missing file', async () => {
    expect(await readExtractedRegularFile(root, ['meta', 'absent.json'])).toEqual({
      missing: true,
    });
    expect(await readExtractedRegularFile(root, ['absent', 'manifest.json'])).toEqual({
      missing: true,
    });
  });

  it('refuses the file when it is an in-root symlink', async () => {
    await fs.symlink('manifest.json', path.join(root, 'meta/link.json'));

    // fails-when: the read follows the link (here to a valid in-root file)
    expect(await readExtractedRegularFile(root, ['meta', 'link.json'])).toEqual({
      refused: 'it is a symlink',
    });
  });

  it('refuses the file when a directory above it is an in-root symlink', async () => {
    await fs.symlink('meta', path.join(root, 'meta-link'));

    // fails-when: only the last path component is checked for a link
    expect(await readExtractedRegularFile(root, ['meta-link', 'manifest.json'])).toEqual({
      refused: 'a directory above it is a symlink or a file',
    });
  });

  it('refuses a directory at the path', async () => {
    await fs.mkdir(path.join(root, 'meta/dir.json'));

    expect(await readExtractedRegularFile(root, ['meta', 'dir.json'])).toEqual({
      refused: 'it is not a regular file',
    });
  });

  it.skipIf(onWindows)('refuses a FIFO without blocking on it', async () => {
    execFileSync('mkfifo', [path.join(root, 'meta/fifo.json')]);

    // fails-when: the FIFO is opened for reading, which waits for a writer forever
    expect(await readExtractedRegularFile(root, ['meta', 'fifo.json'])).toEqual({
      refused: 'it is not a regular file',
    });
  });

  it.skipIf(!existsSync('/dev/zero'))('refuses a character device such as /dev/zero', async () => {
    // fails-when: a device is read, which for /dev/zero never ends
    expect(await readExtractedRegularFile('/dev', ['zero'])).toEqual({
      refused: 'it is not a regular file',
    });
  });
});

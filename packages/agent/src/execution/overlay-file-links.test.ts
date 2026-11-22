import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  confineFileLinks,
  relinkFileSymlinks,
  type FileLinkCandidate,
} from './overlay-file-links.js';

describe('overlay file links', () => {
  let tmp: string;
  let root: string;
  let extract: string;

  beforeEach(async () => {
    tmp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'kici-file-links-')));
    root = path.join(tmp, 'repo');
    extract = path.join(tmp, 'extract');
    await fs.mkdir(root);
    await fs.mkdir(extract);
  });

  afterEach(async () => {
    await fs.rm(tmp, { recursive: true, force: true });
  });

  /** Write `content` at `rel` in the repository (the copy) and in the extraction (the verified target). */
  async function written(rel: string, content: string): Promise<void> {
    for (const base of [root, extract]) {
      await fs.mkdir(path.dirname(path.join(base, rel)), { recursive: true });
      await fs.writeFile(path.join(base, rel), content);
    }
  }

  /** A copied file link at `rel` reading `text`, whose verified target is `target`. */
  async function candidate(rel: string, text: string, target: string): Promise<FileLinkCandidate> {
    const content = await fs.readFile(path.join(extract, target), 'utf8');
    await fs.mkdir(path.dirname(path.join(root, rel)), { recursive: true });
    await fs.writeFile(path.join(root, rel), content);
    return { key: rel, dest: path.join(root, rel), src: path.join(extract, target), text, target };
  }

  /** What the applier wrote: each repository file by real path, mapped to its extracted source. */
  const copiesOf = (rels: string[], links: FileLinkCandidate[]): Map<string, string> =>
    new Map([
      ...rels.map((rel): [string, string] => [path.join(root, rel), path.join(extract, rel)]),
      ...links.map((l): [string, string] => [l.dest, l.src]),
    ]);

  const isLink = async (rel: string): Promise<boolean> =>
    (await fs.lstat(path.join(root, rel))).isSymbolicLink();

  describe('confineFileLinks', () => {
    it('refuses a link that escapes only through another link the overlay creates', async () => {
      await written('x', 'x');
      // `b -> .` stays inside alone. `d1/d2/a -> ../../b/../x` stays inside
      // while `b` is a plain file, but leaves the repository once `b` is a link
      // to the root: `b/..` is then the root's parent.
      const b = await candidate('b', '.', 'x');
      const a = await candidate('d1/d2/a', '../../b/../x', 'x');
      // fails-when: each text is walked against the disk alone (an empty pending view)
      expect((await confineFileLinks([b, a], root)).map((c) => c.key)).toEqual(['b']);
      // Positive control: walked alone, the escaping link looks confined.
      expect((await confineFileLinks([a], root)).map((c) => c.key)).toEqual(['d1/d2/a']);
    });

    it.each([
      ['an absolute text', '/etc/passwd'],
      ['a text climbing above the repository', '../outside'],
    ])('refuses %s', async (_case, text) => {
      await written('x', 'x');
      const link = await candidate('link', text, 'x');
      expect(await confineFileLinks([link], root)).toEqual([]);
    });
  });

  describe('relinkFileSymlinks', () => {
    it('recreates an in-repository link, through an in-repository directory link', async () => {
      await written('docs/a.yaml', 'a');
      await fs.symlink('docs', path.join(root, 'docs-link'));
      const link = await candidate('site/alerts.yaml', '../docs-link/a.yaml', 'docs/a.yaml');
      const copied = copiesOf(['docs/a.yaml'], [link]);

      // breaks-if-wrong: a confined link to the file the overlay wrote is recreated
      expect(await relinkFileSymlinks([link], root, copied)).toBe(1);
      expect(await fs.readlink(link.dest)).toBe('../docs-link/a.yaml');
      expect(await fs.readFile(link.dest, 'utf8')).toBe('a');
    });

    it('keeps the copy of a link that resolves to another file than its verified target', async () => {
      await written('verified.txt', 'verified');
      await written('other.txt', 'other');
      // The text reaches `other.txt` in the repository; the checksum covered `verified.txt`.
      const link = await candidate('link', 'other.txt', 'verified.txt');
      const copied = copiesOf(['verified.txt', 'other.txt'], [link]);

      // fails-when: a link is kept without checking that it reads the verified bytes
      expect(await relinkFileSymlinks([link], root, copied)).toBe(0);
      expect(await isLink('link')).toBe(false);
      expect(await fs.readFile(link.dest, 'utf8')).toBe('verified');
    });

    it('keeps the copy of a link whose target the overlay did not write', async () => {
      await written('clone-only.txt', 'from the clone');
      const link = await candidate('link', 'clone-only.txt', 'clone-only.txt');

      // fails-when: a link may point at a clone file no checksum covered
      expect(await relinkFileSymlinks([link], root, copiesOf([], [link]))).toBe(0);
      expect(await isLink('link')).toBe(false);
    });

    it('keeps the copy of a link whose target holds a copy from another source', async () => {
      // The clone has `p -> q`: the overlay's `p/f` (bytes B) lands at `q/f`, while
      // the link's checksum covered the extracted `q/f` (bytes A).
      await written('q/f', 'A');
      await fs.mkdir(path.join(extract, 'p'));
      await fs.writeFile(path.join(extract, 'p/f'), 'B');
      await fs.writeFile(path.join(root, 'q/f'), 'B');
      const link = await candidate('L', 'q/f', 'q/f');
      const copied = new Map([
        [path.join(root, 'q/f'), path.join(extract, 'p/f')],
        [link.dest, link.src],
      ]);

      // fails-when: only "some copy was written at the target" is checked, not its source
      expect(await relinkFileSymlinks([link], root, copied)).toBe(0);
      expect(await isLink('L')).toBe(false);
      expect(await fs.readFile(link.dest, 'utf8')).toBe('A');
    });

    it('keeps both escaping and confined links right in one overlay', async () => {
      await written('x', 'x');
      const b = await candidate('b', 'x', 'x');
      const a = await candidate('d1/d2/a', '../../b/../x', 'x');
      const copied = copiesOf(['x'], [b, a]);

      expect(await relinkFileSymlinks([b, a], root, copied)).toBe(1);
      expect(await isLink('b')).toBe(true);
      // `b` links to a file, so `b/..` cannot resolve: `a` stays a copy.
      expect(await isLink('d1/d2/a')).toBe(false);
      expect(await fs.readFile(a.dest, 'utf8')).toBe('x');
    });
  });
});

/**
 * Directory symlinks an overlay recreates in the repository.
 *
 * The uploader ships a symlink whose target is a directory as its link text in
 * the manifest's `symlinks` map. Before anything is applied, each one must point
 * inside the repository at every step the kernel takes to resolve it; once the
 * files and deletions are applied, each one is created.
 */

import fs from 'node:fs/promises';
import path from 'node:path';

/** Symlinks followed while resolving one path before it is refused (the Linux limit). */
export const MAX_LINK_HOPS = 40;

/** A directory symlink the overlay creates. */
export interface CheckedLink {
  key: string;
  dest: string;
  text: string;
}

/**
 * The repository as a directory symlink sees it once it is created: the
 * overlay's deletions are applied and its other directory symlinks exist. Both
 * are keyed by real repo-relative path.
 */
export interface LinkView {
  realRoot: string;
  deleted: ReadonlySet<string>;
  pending: ReadonlyMap<string, string>;
}

/** True when `target` is `root` itself or lies beneath it. */
export function isWithin(root: string, target: string): boolean {
  return target === root || target.startsWith(root + path.sep);
}

/** The link text at `abs` when a symlink is there once the overlay's deletions ran. */
async function linkTextAt(view: LinkView, abs: string): Promise<string | undefined> {
  const rel = path.relative(view.realRoot, abs);
  const pending = view.pending.get(rel);
  if (pending !== undefined) return pending;
  if (view.deleted.has(rel)) return undefined;
  const stat = await fs.lstat(abs).catch(() => undefined);
  return stat?.isSymbolicLink() ? fs.readlink(abs) : undefined;
}

/**
 * Resolve link text `text`, created in the real directory `startDir`, one
 * component at a time the way the kernel does: `..` climbs from the real
 * directory reached so far, and every symlink met is followed — one already on
 * disk, or one the same overlay creates. Returns why the text is refused, or
 * undefined when every step stays inside the repository.
 *
 * Resolving the text with `path.resolve` alone is not enough: it collapses `..`
 * before following links, so `a/..` looks like the current directory even when
 * `a` is a link to somewhere else.
 */
async function walkLinkText(
  view: LinkView,
  startDir: string,
  text: string,
): Promise<string | undefined> {
  const parts = text.split('/');
  let current = startDir;
  let followed = 0;
  while (parts.length > 0) {
    const part = parts.shift() as string;
    if (part === '' || part === '.') continue;
    if (part === '..') {
      current = path.dirname(current);
    } else {
      const next = path.join(current, part);
      const linkText = await linkTextAt(view, next);
      if (linkText === undefined) {
        current = next;
      } else {
        if (++followed > MAX_LINK_HOPS) return 'link target does not resolve: too many symlinks';
        if (path.isAbsolute(linkText)) current = path.parse(linkText).root;
        parts.unshift(...linkText.split('/'));
      }
    }
    // fails-when: `sub/lib -> ..` where `sub` is a link to the repository root
    // breaks-if-wrong: `packages/app/lib -> ../../shared` climbs and stays inside
    if (!isWithin(view.realRoot, current)) {
      return 'link target leaves the repository through a symlink';
    }
  }
  return undefined;
}

/**
 * Why a directory symlink created at the real path `realDest` reading `text` is
 * refused, or undefined when it stays inside the repository: its text must be
 * relative, resolve inside the repository as written, and stay inside it at
 * every step the kernel takes to resolve it.
 */
export async function linkRefusal(
  realDest: string,
  text: unknown,
  view: LinkView,
): Promise<string | undefined> {
  if (typeof text !== 'string' || text.length === 0) return 'link text is not a non-empty string';
  if (text.includes('\0')) return 'link text contains a NUL byte';
  // fails-when: the text is `/etc`, which names the agent host's own directory
  // breaks-if-wrong: a relative text such as `shared` must still pass
  if (path.isAbsolute(text)) return 'link text is an absolute path';
  // fails-when: `a/lib -> ../../outside` climbs above the repository as written
  if (!isWithin(view.realRoot, path.resolve(path.dirname(realDest), text))) {
    return 'link target resolves outside the repository';
  }
  return walkLinkText(view, path.dirname(realDest), text);
}

/**
 * Remove a directory an overlay entry replaces with a file or a symlink. The
 * check before applying proved it holds nothing but directories once the
 * overlay's deletions ran; a file or link found here anyway is not removed.
 */
export async function removeEmptyTree(dir: string, key: string): Promise<void> {
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) {
      throw new Error(
        `Overlay cannot replace the directory ${JSON.stringify(key)}: it still holds ${entry.name}`,
      );
    }
    await removeEmptyTree(path.join(dir, entry.name), key);
  }
  await fs.rmdir(dir);
}

/**
 * Create each checked directory symlink, replacing whatever the clone has at
 * its path: a file or a link is unlinked (never followed), and an emptied
 * directory is removed. Returns the number created.
 */
export async function applySymlinks(links: readonly CheckedLink[]): Promise<number> {
  for (const { key, dest, text } of links) {
    await fs.mkdir(path.dirname(dest), { recursive: true });
    const existing = await fs.lstat(dest).catch(() => undefined);
    if (existing?.isDirectory()) await removeEmptyTree(dest, key);
    else if (existing) await fs.unlink(dest);
    await fs.symlink(text, dest, 'dir');
  }
  return links.length;
}

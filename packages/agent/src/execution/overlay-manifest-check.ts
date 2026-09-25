/**
 * Validation of an overlay manifest, before anything is applied.
 *
 * The manifest is written by whoever uploaded the overlay, and the overlay is
 * applied on the agent host for container jobs, so no entry may reach outside
 * the repository: not through its own path, not through a symlink the
 * repository already has, and not through a directory symlink the same overlay
 * creates. Every check runs before the first write, so a refused overlay
 * applies nothing.
 *
 * The overlay applies its deletions first, then its files, then its directory
 * symlinks. Each entry's parent directory is resolved against the repository as
 * that step finds it.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import {
  isWithin,
  linkRefusal,
  MAX_LINK_HOPS,
  type CheckedLink,
  type LinkView,
} from './overlay-symlinks.js';

/**
 * Manifest describing the overlay contents.
 * Written by the CLI uploader, read by the agent.
 */
export interface OverlayManifest {
  /** HEAD SHA the overlay is based on */
  sha: string;
  /** Files deleted locally (need to be removed on agent) */
  deletions: string[];
  /** SHA256 checksums of each included file */
  checksums: Record<string, string>;
  /**
   * Symlinks whose target is a directory: repo-relative path → link text.
   * Absent from a manifest written by a CLI that predates it.
   */
  symlinks?: Record<string, string>;
}

/** A file the overlay writes into the repository, at its real path. */
export interface CheckedCopy {
  key: string;
  src: string;
  dest: string;
}

/** A path the overlay removes, at its real path. */
export interface CheckedDeletion {
  key: string;
  target: string;
  /**
   * The path holds a file or link now, and the rest of the check assumed it is
   * gone once the deletions ran; removing it must not fail.
   */
  mustRemove: boolean;
}

/**
 * Every manifest entry at the real path it is applied to. Applying to these
 * paths follows no symlink below the repository root, so the result does not
 * depend on the order entries are applied in.
 */
export interface CheckedManifest {
  copies: CheckedCopy[];
  deletions: CheckedDeletion[];
  links: CheckedLink[];
}

/** The step an entry is applied in, which decides what its parent directory sees. */
enum ApplyStep {
  /** Deletions run first, against the repository as it is. */
  Deletion = 'deletion',
  /** Files run next: deleted files and links are gone, and no new link exists yet. */
  Copy = 'copy',
  /** Directory symlinks run last. */
  Link = 'link',
}

/** The kind of manifest entry, as a refusal names it. */
enum EntryKind {
  File = 'file',
  Deletion = 'deletion',
  Symlink = 'symlink',
}

type Resolved = { real: string } | { refused: string };

/** What the walk knows about the overlay: its deletions, links, and files. */
interface RepoView extends LinkView {
  /** Files the overlay writes, by real repo-relative path. */
  files: ReadonlySet<string>;
}

/** A validated entry plus its real repo-relative path. */
interface Placed<T> {
  entry: T;
  rel: string;
}

const quote = (value: unknown): string => JSON.stringify(value);

/** One line of the refusal error, naming the entry, its kind, and the reason. */
const refusal = (key: unknown, kind: EntryKind, reason: string): string =>
  `${quote(key)} (${kind}): ${reason}`;

/**
 * Resolve one manifest path inside `root`, or say why it is refused: not an
 * absolute path, not one that climbs out with `..`, and not one carrying a NUL
 * byte (which the filesystem would truncate).
 */
function resolveInside(root: string, key: unknown): { path: string } | { refused: string } {
  if (typeof key !== 'string' || key.length === 0) return { refused: 'not a non-empty string' };
  if (key.includes('\0')) return { refused: 'contains a NUL byte' };
  if (path.isAbsolute(key)) return { refused: 'is an absolute path' };
  const resolved = path.resolve(root, key);
  // fails-when: a key such as `../x` or `a/../../x` resolves above the root
  // breaks-if-wrong: a nested key such as `src/a/b.ts` must still resolve inside
  if (!resolved.startsWith(root + path.sep)) return { refused: 'resolves outside the repository' };
  return { path: resolved };
}

/** The nearest existing ancestor of `target` (or `target` itself), with every symlink resolved. */
async function realAncestor(target: string): Promise<string> {
  let current = target;
  for (;;) {
    try {
      return await fs.realpath(current);
    } catch {
      const parent = path.dirname(current);
      if (parent === current) return current;
      current = parent;
    }
  }
}

/** True when `value` is a plain object usable as a string-keyed map. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Throw unless the manifest has the shape every CLI version writes. */
function assertManifestShape(manifest: OverlayManifest): void {
  // fails-when: `symlinks` is present but not an object map (e.g. an array)
  // breaks-if-wrong: a manifest from a CLI that predates `symlinks` has no such key and passes
  if (
    manifest === null ||
    typeof manifest !== 'object' ||
    !Array.isArray(manifest.deletions) ||
    manifest.checksums === null ||
    typeof manifest.checksums !== 'object' ||
    (manifest.symlinks !== undefined && !isRecord(manifest.symlinks))
  ) {
    throw new Error(
      'Overlay manifest is malformed: expected deletions[], checksums{} and an optional symlinks{}',
    );
  }
}

/**
 * Walk `parts` from the real directory `start`, one component at a time. Every
 * symlink met is followed and must resolve, inside the repository, to a
 * directory that exists now: a link that would resolve only once the overlay has
 * created something is refused, since whether it does would depend on the order
 * entries are applied in. For a file or a link, a path the overlay deletes counts
 * as gone. On the entry's own path (`inLink` false) a missing directory is fine:
 * `mkdir` creates it.
 */
async function walkDirs(
  view: RepoView,
  step: ApplyStep,
  start: string,
  parts: string[],
  inLink: boolean,
  budget: { hops: number },
): Promise<Resolved> {
  const seesChanges = step !== ApplyStep.Deletion;
  let current = start;
  let missing = false;
  for (const part of parts) {
    if (part === '' || part === '.') continue;
    if (part === '..') {
      current = path.dirname(current);
    } else {
      const next = path.join(current, part);
      const rel = path.relative(view.realRoot, next);
      // fails-when: the clone has `y -> d` and the overlay writes both a file `y` and `y/f`
      // breaks-if-wrong: a file beside another file in the same directory is still written
      if (seesChanges && view.files.has(rel)) {
        return {
          refused: inLink
            ? `passes through ${quote(rel)}, which the overlay replaces with a file`
            : `lies beneath the file ${quote(rel)}`,
        };
      }
      if (seesChanges && view.pending.has(rel)) {
        return {
          refused: inLink
            ? `passes through the symlink ${quote(rel)}, which the overlay creates`
            : `lies beneath the symlink ${quote(rel)}`,
        };
      }
      const stat = missing ? undefined : await fs.lstat(next).catch(() => undefined);
      const deleted = seesChanges && !!stat && !stat.isDirectory() && view.deleted.has(rel);
      if (!stat || deleted) {
        // fails-when: the repository has `p/q/x -> ../../nonexist` and an entry lies beneath `p/q/x`
        // breaks-if-wrong: a new file beneath directories that do not exist yet is still written
        if (inLink) return { refused: 'passes through a symlink that does not resolve' };
        missing = true;
        current = next;
      } else if (stat.isSymbolicLink()) {
        if (++budget.hops > MAX_LINK_HOPS) return { refused: 'passes through too many symlinks' };
        const text = await fs.readlink(next);
        const base = path.isAbsolute(text) ? path.parse(text).root : current;
        const target = await walkDirs(view, step, base, text.split('/'), true, budget);
        if ('refused' in target) return target;
        current = target.real;
      } else if (stat.isDirectory()) {
        current = next;
      } else {
        return { refused: `passes through ${quote(rel)}, which is not a directory` };
      }
    }
    // fails-when: a symlink on the way leads above the repository root
    // breaks-if-wrong: a link to a sibling directory inside the repository still resolves
    if (!isWithin(view.realRoot, current)) {
      return { refused: 'passes through a symlink out of the repository' };
    }
  }
  if (!isWithin(view.realRoot, current)) {
    return { refused: 'passes through a symlink out of the repository' };
  }
  return { real: current };
}

/** Resolves an entry's parent directory for one step, caching per directory. */
function parentResolver(
  view: RepoView,
  repoRoot: string,
): (step: ApplyStep, dest: string) => Promise<Resolved> {
  const cache = new Map<string, Promise<Resolved>>();
  return (step, dest) => {
    const relParent = path.relative(repoRoot, path.dirname(dest));
    const cacheKey = `${step}\0${relParent}`;
    let resolved = cache.get(cacheKey);
    if (!resolved) {
      const parts = relParent === '' ? [] : relParent.split(path.sep);
      resolved = walkDirs(view, step, view.realRoot, parts, false, { hops: 0 });
      cache.set(cacheKey, resolved);
    }
    return resolved;
  };
}

/** The real repo-relative path of `dest` once its parent resolved to `realParent`. */
function realRel(view: LinkView, realParent: string, dest: string): string {
  return path.relative(view.realRoot, path.join(realParent, path.basename(dest)));
}

/**
 * When `abs` is a real directory an entry replaces, the first file or link in it
 * the overlay does not delete: the directory can be removed only once it holds
 * nothing but directories.
 */
async function leftoverIn(view: LinkView, abs: string): Promise<string | undefined> {
  const stat = await fs.lstat(abs).catch(() => undefined);
  if (!stat?.isDirectory()) return undefined;
  for (const entry of await fs.readdir(abs, { withFileTypes: true })) {
    const child = path.join(abs, entry.name);
    const left = entry.isDirectory()
      ? await leftoverIn(view, child)
      : view.deleted.has(path.relative(view.realRoot, child))
        ? undefined
        : path.relative(view.realRoot, child);
    if (left) return left;
  }
  return undefined;
}

/**
 * Deletions run first, against the repository as it is. Each is placed at its
 * real path and removed there, so deleting one path can never make another
 * deletion miss: the apply unlinks only files and links, never a directory on
 * another deletion's real path. Two keys naming one real path become one
 * deletion.
 */
async function checkDeletions(
  keys: unknown[],
  repoRoot: string,
  view: RepoView,
  refused: string[],
): Promise<Array<Placed<CheckedDeletion>>> {
  const resolve = parentResolver(view, repoRoot);
  const placed = new Map<string, Placed<CheckedDeletion>>();
  for (const key of keys) {
    const target = resolveInside(repoRoot, key);
    const parent = 'refused' in target ? target : await resolve(ApplyStep.Deletion, target.path);
    if ('refused' in parent || 'refused' in target) {
      refused.push(refusal(key, EntryKind.Deletion, 'refused' in parent ? parent.refused : ''));
      continue;
    }
    const rel = realRel(view, parent.real, target.path);
    if (placed.has(rel)) continue;
    const real = path.join(view.realRoot, rel);
    const stat = await fs.lstat(real).catch(() => undefined);
    const mustRemove = !!stat && !stat.isDirectory();
    placed.set(rel, { entry: { key: key as string, target: real, mustRemove }, rel });
  }
  return [...placed.values()];
}

/**
 * Place every directory symlink at its real path, before any link is assumed
 * to exist, so each can be found by the others' checks.
 */
async function placeLinks(
  symlinks: Record<string, unknown>,
  repoRoot: string,
  view: RepoView,
  refused: string[],
): Promise<Array<Placed<{ key: string; dest: string; text: unknown }>>> {
  const resolve = parentResolver(view, repoRoot);
  const placed: Array<Placed<{ key: string; dest: string; text: unknown }>> = [];
  const seen = new Map<string, string>();
  for (const [key, text] of Object.entries(symlinks)) {
    const dest = resolveInside(repoRoot, key);
    const parent = 'refused' in dest ? dest : await resolve(ApplyStep.Link, dest.path);
    if ('refused' in parent || 'refused' in dest) {
      refused.push(refusal(key, EntryKind.Symlink, 'refused' in parent ? parent.refused : ''));
      continue;
    }
    const rel = realRel(view, parent.real, dest.path);
    const other = seen.get(rel);
    if (other !== undefined) {
      refused.push(
        refusal(key, EntryKind.Symlink, `names the same path as the symlink ${quote(other)}`),
      );
      continue;
    }
    seen.set(rel, key);
    placed.push({ entry: { key, dest: dest.path, text }, rel });
  }
  return placed;
}

/**
 * Place every file at its real path. Files run after the deletions and before
 * any directory symlink exists.
 */
async function placeCopies(
  checksums: Record<string, string>,
  roots: { repoRoot: string; extractRoot: string },
  view: RepoView,
  refused: string[],
): Promise<Array<Placed<CheckedCopy & { written: string }>>> {
  const resolve = parentResolver(view, roots.repoRoot);
  const placed: Array<Placed<CheckedCopy & { written: string }>> = [];
  const seen = new Map<string, string>();
  for (const key of Object.keys(checksums)) {
    const dest = resolveInside(roots.repoRoot, key);
    const src = resolveInside(roots.extractRoot, key);
    if ('refused' in dest || 'refused' in src) {
      refused.push(refusal(key, EntryKind.File, 'refused' in dest ? dest.refused : 'refused'));
      continue;
    }
    const parent = await resolve(ApplyStep.Copy, dest.path);
    if ('refused' in parent) {
      refused.push(refusal(key, EntryKind.File, parent.refused));
      continue;
    }
    const rel = realRel(view, parent.real, dest.path);
    const reason = await copyRefusal(view, rel, seen);
    if (reason) {
      refused.push(refusal(key, EntryKind.File, reason));
      continue;
    }
    seen.set(rel, key);
    const entry = { key, src: src.path, dest: path.join(view.realRoot, rel), written: dest.path };
    placed.push({ entry, rel });
  }
  return placed;
}

/** Why a file at real path `rel` cannot be written, or undefined. */
async function copyRefusal(
  view: RepoView,
  rel: string,
  seen: ReadonlyMap<string, string>,
): Promise<string | undefined> {
  // fails-when: the same key is listed both as a file and as a directory symlink
  if (view.pending.has(rel)) return 'is also listed as a symlink';
  const other = seen.get(rel);
  if (other !== undefined) return `names the same path as the file ${quote(other)}`;
  const left = await leftoverIn(view, path.join(view.realRoot, rel));
  if (left) return `replaces the directory ${quote(rel)}, which still holds ${quote(left)}`;
  return undefined;
}

/**
 * Walk each placed file's parent again now that every file is known: no file
 * may lie beneath a path another file replaces, which would fail midway once
 * that path is a file.
 */
async function filesBeneathFiles(
  copies: Array<Placed<CheckedCopy & { written: string }>>,
  repoRoot: string,
  view: RepoView,
  refused: string[],
): Promise<void> {
  const resolve = parentResolver(view, repoRoot);
  for (const { entry } of copies) {
    const parent = await resolve(ApplyStep.Copy, entry.written);
    if ('refused' in parent) refused.push(refusal(entry.key, EntryKind.File, parent.refused));
  }
}

/** Why one directory symlink cannot be created, or undefined. */
async function linkEntryRefusal(
  entry: { dest: string; text: unknown },
  rel: string,
  resolve: (step: ApplyStep, dest: string) => Promise<Resolved>,
  view: RepoView,
): Promise<string | undefined> {
  const parent = await resolve(ApplyStep.Link, entry.dest);
  if ('refused' in parent) return parent.refused;
  const reason = await linkRefusal(path.join(view.realRoot, rel), entry.text, view);
  if (reason) return reason;
  const left = await leftoverIn(view, path.join(view.realRoot, rel));
  // fails-when: the directory the link replaces still holds a file the overlay keeps
  // breaks-if-wrong: a directory whose files the overlay deletes is still replaced
  if (left) return `replaces the directory ${quote(rel)}, which still holds ${quote(left)}`;
  return undefined;
}

/** Directory symlinks run last, once the files and deletions are in place. */
async function checkLinks(
  placed: Array<Placed<{ key: string; dest: string; text: unknown }>>,
  repoRoot: string,
  view: RepoView,
  refused: string[],
): Promise<CheckedLink[]> {
  const resolve = parentResolver(view, repoRoot);
  const links: CheckedLink[] = [];
  for (const { entry, rel } of placed) {
    const reason = await linkEntryRefusal(entry, rel, resolve, view);
    if (reason) {
      refused.push(refusal(entry.key, EntryKind.Symlink, reason));
      continue;
    }
    const dest = path.join(view.realRoot, rel);
    links.push({ key: entry.key, dest, text: entry.text as string });
  }
  return links;
}

/**
 * Validate the whole manifest before anything touches the filesystem, so a
 * refused overlay applies nothing at all. Throws one error naming every
 * refused key.
 */
export async function checkManifest(
  manifest: OverlayManifest,
  repoDir: string,
  extractDir: string,
): Promise<CheckedManifest> {
  assertManifestShape(manifest);
  const repoRoot = path.resolve(repoDir);
  const realRoot = await realAncestor(repoRoot);
  const refused: string[] = [];
  const none = { deleted: new Set<string>(), pending: new Map<string, string>() };

  const deletions = await checkDeletions(
    manifest.deletions,
    repoRoot,
    { realRoot, ...none, files: new Set() },
    refused,
  );
  const deleted = new Set(deletions.map((d) => d.rel));
  const placedLinks = await placeLinks(
    manifest.symlinks ?? {},
    repoRoot,
    { realRoot, deleted, pending: none.pending, files: new Set() },
    refused,
  );
  const pending = new Map<string, string>();
  for (const { entry, rel } of placedLinks) {
    if (typeof entry.text === 'string') pending.set(rel, entry.text);
  }

  const roots = { repoRoot, extractRoot: path.resolve(extractDir) };
  const copies = await placeCopies(
    manifest.checksums,
    roots,
    { realRoot, deleted, pending, files: new Set() },
    refused,
  );
  const view: RepoView = { realRoot, deleted, pending, files: new Set(copies.map((c) => c.rel)) };
  await filesBeneathFiles(copies, repoRoot, view, refused);
  const links = await checkLinks(placedLinks, repoRoot, view, refused);

  // fails-when: any single entry is refused — the overlay applies nothing
  // breaks-if-wrong: a manifest of contained paths passes untouched
  if (refused.length > 0) {
    throw new Error(
      `Overlay refused: ${refused.length} path(s) cannot be applied inside the repository:\n` +
        refused.map((r) => `  - ${r}`).join('\n'),
    );
  }
  return {
    copies: copies.map(({ entry: { key, src, dest } }) => ({ key, src, dest })),
    deletions: deletions.map((d) => d.entry),
    links,
  };
}

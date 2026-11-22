/**
 * Symbolic links in the uploaded overlay. A file symlink ships as a link entry whose checksum
 * covers its target; the agent dereferences it inside the extracted overlay, so every
 * in-repository link on the way and the final file ship too, changed or not, and recreates the
 * link when its text stays inside the repository. A directory symlink ships as its text in the
 * manifest's `symlinks` map, recreated by the agent. A link whose target cannot ship (outside the
 * repository; for a file link, also excluded by git or `.kiciignore`) is skipped with a warning.
 */

import { execFileSync } from 'node:child_process';
import type { Stats } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';

/** Symlinks followed while resolving one path before giving up (the Linux limit). */
const MAX_LINK_HOPS = 40;

/** The git index mode of a submodule (a gitlink). */
const GITLINK_MODE = '160000';

/** Selected paths the overlay leaves out, which the CLI warns about. */
export interface OverlaySkipped {
  /** Gitlinks in the index: their files are not uploaded. */
  submodules: string[];
  /** Untracked nested git repositories: their files are not uploaded. */
  nestedRepositories: string[];
  /** Tracked symlinks whose target does not exist: absent from the remote workspace. */
  danglingLinks: string[];
  /** Symlinks whose target is outside the repository or absolute, and file links not shipped. */
  unshippedLinks: string[];
}

export interface OverlayEntries {
  /** Regular files and file symlinks: shipped as content and checksummed. */
  files: string[];
  /** Directory symlinks: repo-relative path → link text. */
  symlinks: Record<string, string>;
  /** Paths the agent removes. */
  deletions: string[];
  skipped: OverlaySkipped;
}

/** As `selectOverlayFiles` returns them. */
interface SelectedPaths {
  existingFiles: string[];
  deletedFiles: string[];
}

enum EntryKind {
  File = 'file',
  FileLink = 'fileLink',
  DirLink = 'dirLink',
  BeneathLink = 'beneathLink',
  Directory = 'directory',
}

type PathKind =
  | { kind: EntryKind.File }
  | { kind: EntryKind.FileLink }
  | { kind: EntryKind.DirLink; text: string }
  | { kind: EntryKind.BeneathLink }
  | { kind: EntryKind.Directory };

/** Holds `manifest.json` in the tarball; no repository path under it ships (it would collide). */
export const OVERLAY_MANIFEST_DIR = '.kici-overlay-tmp';

export function isReservedOverlayPath(relPath: string): boolean {
  return relPath === OVERLAY_MANIFEST_DIR || relPath.startsWith(`${OVERLAY_MANIFEST_DIR}/`);
}

/** Whether `dir` or a directory above it is a symlink; memoized, since every file in it asks. */
function dirIsLinked(
  realRoot: string,
  dir: string,
  cache: Map<string, Promise<boolean>>,
): Promise<boolean> {
  if (dir === '.' || dir === '') return Promise.resolve(false);
  let known = cache.get(dir);
  if (!known) {
    known = (async () => {
      if (await dirIsLinked(realRoot, path.posix.dirname(dir), cache)) return true;
      const stat = await fs.lstat(path.join(realRoot, dir)).catch(() => undefined);
      return stat?.isSymbolicLink() ?? false;
    })();
    cache.set(dir, known);
  }
  return known;
}

/** Classify one selected path without following it. */
async function classifyPath(
  realRoot: string,
  file: string,
  linkedDirs: Map<string, Promise<boolean>>,
): Promise<PathKind> {
  // git tracks nothing beneath a symlink: a listed path there (a directory replaced by a link)
  // is gone, though it reads through the link.
  if (await dirIsLinked(realRoot, path.posix.dirname(file), linkedDirs)) {
    return { kind: EntryKind.BeneathLink };
  }
  const full = path.join(realRoot, file);
  const stat = await fs.lstat(full).catch(() => undefined);
  // A directory is never content: a submodule, a nested repository, or a replaced file or link.
  if (stat?.isDirectory()) return { kind: EntryKind.Directory };
  if (!stat?.isSymbolicLink()) return { kind: EntryKind.File };
  const target = await fs.stat(full).catch(() => undefined);
  if (target?.isDirectory()) return { kind: EntryKind.DirLink, text: await fs.readlink(full) };
  return { kind: EntryKind.FileLink };
}

/** Where {@link walkLink} ends: `target` is '' for the repository root, `last` unset after `..`. */
interface WalkedLink {
  hops: string[];
  target: string;
  last: Stats | undefined;
}

/**
 * Follow `linkRel` one component at a time, as the kernel does, to every later symlink (`hops`)
 * and the path reached, both repo-relative. Null, as the agent refuses the link, when the walk
 * leaves the repository, meets an absolute text (resolved on the agent's host), loops or misses.
 */
async function walkLink(realRoot: string, linkRel: string): Promise<WalkedLink | null> {
  const hops: string[] = [];
  const pending = linkRel.split('/');
  let resolved = '';
  let last: Stats | undefined;
  let followed = 0;
  while (pending.length > 0) {
    const part = pending.shift() as string;
    if (part === '' || part === '.') continue;
    if (part === '..') {
      // fails-when: a link text such as `../outside.txt` climbs above the repository root
      // breaks-if-wrong: `../docs/a.yaml` from `site/` must still land inside
      if (resolved === '') return null;
      const parent = path.posix.dirname(resolved);
      resolved = parent === '.' ? '' : parent;
      last = undefined;
      continue;
    }
    const next = resolved === '' ? part : `${resolved}/${part}`;
    last = await fs.lstat(path.join(realRoot, next)).catch(() => undefined);
    if (!last) return null;
    if (last.isSymbolicLink()) {
      if (++followed > MAX_LINK_HOPS) return null;
      const text = await fs.readlink(path.join(realRoot, next));
      if (path.isAbsolute(text)) return null;
      if (next !== linkRel) hops.push(next);
      pending.unshift(...text.split('/'));
      continue;
    }
    resolved = next;
  }
  return { hops, target: resolved, last };
}

/**
 * The file a file symlink resolves to: every later symlink plus the final regular file,
 * repo-relative and free of symlinked directories. Null when the agent refuses the link
 * ({@link walkLink}) or the chain ends on a non-regular file.
 */
async function followLinkChain(
  realRoot: string,
  linkRel: string,
): Promise<{ hops: string[]; target: string } | null> {
  const walked = await walkLink(realRoot, linkRel);
  if (!walked?.last?.isFile()) return null;
  return { hops: walked.hops, target: walked.target };
}

/**
 * The directory symlinks among `links` that {@link walkLink} refuses. Shipped, one dangles remotely
 * and a write through it fails, such as `pnpm install` into a symlinked `node_modules`.
 */
async function outsideDirLinks(realRoot: string, links: string[]): Promise<string[]> {
  const outside: string[] = [];
  for (const link of links) {
    // fails-when: `.kici/node_modules -> /home/dev/store` ships and dangles on the agent
    // breaks-if-wrong: `lib -> shared`, an in-repository directory, still ships as a link
    if (!(await walkLink(realRoot, link))) outside.push(link);
  }
  return outside;
}

/**
 * The `paths` git ships (tracked, or untracked unignored), so a link never carries a gitignored
 * file (such as `.kici/.env.local`) along.
 */
function gitShippable(repoRoot: string, paths: string[]): Set<string> {
  try {
    const out = execFileSync(
      'git',
      [
        '--literal-pathspecs',
        'ls-files',
        '--cached',
        '--others',
        '--exclude-standard',
        '-z',
        '--',
        ...paths,
      ],
      { cwd: repoRoot, encoding: 'utf-8', maxBuffer: 64 * 1024 * 1024 },
    );
    return new Set(out.split('\0').filter((p) => p.length > 0));
  } catch {
    return new Set();
  }
}

/**
 * Split the file symlinks by whether the agent can dereference them. `targets`: the not yet
 * shipped links and files the kept links resolve through. `unshipped`: links whose chain leaves
 * the repository, uses an absolute text, or holds a path git or `.kiciignore` excludes.
 */
async function linkTargets(
  repoRoot: string,
  realRoot: string,
  fileLinks: string[],
  shipped: Set<string>,
  isIgnored: (file: string) => boolean,
): Promise<{ targets: string[]; unshipped: string[] }> {
  const needs = new Map<string, string[]>();
  const unshipped: string[] = [];
  for (const link of fileLinks) {
    const chain = await followLinkChain(realRoot, link);
    // fails-when: a link to a file outside the repository stays in the upload with no target
    if (chain)
      needs.set(
        link,
        [...chain.hops, chain.target].filter((p) => !shipped.has(p)),
      );
    else unshipped.push(link);
  }
  const wanted = new Set([...needs.values()].flat());
  const shippable = wanted.size > 0 ? gitShippable(repoRoot, [...wanted]) : new Set<string>();
  const ships = (p: string) => shippable.has(p) && !isIgnored(p) && !isReservedOverlayPath(p);
  const targets = new Set<string>();
  for (const [link, paths] of needs) {
    // fails-when: a link to a gitignored or .kiciignored file ships while its target does not
    // breaks-if-wrong: a link to a tracked, shipped file still ships with its target
    if (paths.every(ships)) for (const p of paths) targets.add(p);
    else unshipped.push(link);
  }
  return { targets: [...targets], unshipped };
}

/** The paths among `dirs` the git index in `repoRoot` records as a submodule. */
export function gitlinkPaths(repoRoot: string, dirs: string[]): Set<string> {
  const wanted = new Set(dirs);
  const out = execFileSync(
    'git',
    ['--literal-pathspecs', 'ls-files', '--stage', '-z', '--', ...dirs],
    { cwd: repoRoot, encoding: 'utf-8', maxBuffer: 64 * 1024 * 1024 },
  );
  const found = new Set<string>();
  // `<mode> <object> <stage>\t<path>`; a pathspec matches beneath a directory: exact paths only.
  for (const entry of out.split('\0')) {
    const tab = entry.indexOf('\t');
    const file = entry.slice(tab + 1);
    if (tab > 0 && entry.startsWith(`${GITLINK_MODE} `) && wanted.has(file)) found.add(file);
  }
  return found;
}

/**
 * Skip a submodule or untracked nested repository (listed with a trailing slash). Any other
 * directory replaced a tracked file or link: a deletion, its files shipping as untracked.
 */
function placeDirectories(repoRoot: string, dirs: string[], entries: OverlayEntries): void {
  if (dirs.length === 0) return;
  const submodules = gitlinkPaths(repoRoot, dirs);
  for (const dir of dirs) {
    // fails-when: a submodule or nested repository is treated as a file (EISDIR)
    // breaks-if-wrong: a symlink replaced by a real directory must still delete the link
    if (submodules.has(dir)) {
      entries.skipped.submodules.push(dir);
    } else if (dir.endsWith('/')) {
      entries.skipped.nestedRepositories.push(dir.replace(/\/+$/, ''));
    } else {
      entries.deletions.push(dir);
    }
  }
}

/** Which run the skipped paths are left out of; it sets the warning's wording. */
export enum SkipContext {
  /** `kici run remote`: the paths are not uploaded. */
  RemoteRun = 'remote-run',
  /** `kici run --local`: the paths are not copied into the isolated checkout. */
  LocalRun = 'local-run',
}

const SKIP_WORDING: Record<SkipContext, { verb: string; where: string }> = {
  [SkipContext.RemoteRun]: { verb: 'Not uploading', where: 'The remote workspace' },
  [SkipContext.LocalRun]: { verb: 'Not copying', where: 'The isolated checkout' },
};

/** One CLI warning per skipped kind, naming every path. */
export function overlaySkipWarnings(skipped: OverlaySkipped, context: SkipContext): string[] {
  const { verb, where } = SKIP_WORDING[context];
  const kinds: Array<[string[], string]> = [
    [skipped.submodules, 'the files of these submodules'],
    [skipped.nestedRepositories, 'the files of these nested git repositories'],
    [skipped.danglingLinks, 'these symbolic links, whose target does not exist'],
    [
      skipped.unshippedLinks,
      'these symbolic links, whose target is outside the repository, an absolute path, or excluded by .gitignore or .kiciignore',
    ],
  ];
  return kinds
    .filter(([paths]) => paths.length > 0)
    .map(
      ([paths, what]) => `${verb} ${what}: ${paths.join(', ')}. ${where} does not contain them.`,
    );
}

type Placer = (file: string, kind: PathKind) => void;

/** A classified selection, plus what adding link targets needs. */
interface Classified {
  entries: OverlayEntries;
  place: Placer;
  fileLinks: string[];
  realRoot: string;
  linkedDirs: Map<string, Promise<boolean>>;
}

/** Classify the selection itself, without adding any link target. */
async function classify(repoRoot: string, selection: SelectedPaths): Promise<Classified> {
  const realRoot = await fs.realpath(repoRoot);
  const linkedDirs = new Map<string, Promise<boolean>>();
  const entries: OverlayEntries = {
    files: [],
    symlinks: {},
    deletions: [...selection.deletedFiles],
    skipped: { submodules: [], nestedRepositories: [], danglingLinks: [], unshippedLinks: [] },
  };
  const fileLinks: string[] = [];
  const directories: string[] = [];

  const place: Placer = (file, kind) => {
    if (kind.kind === EntryKind.BeneathLink) entries.deletions.push(file);
    else if (kind.kind === EntryKind.DirLink) entries.symlinks[file] = kind.text;
    else if (kind.kind === EntryKind.Directory) directories.push(file);
    else entries.files.push(file);
  };

  const kinds = await Promise.all(
    selection.existingFiles.map((file) => classifyPath(realRoot, file, linkedDirs)),
  );
  selection.existingFiles.forEach((file, i) => {
    place(file, kinds[i]);
    if (kinds[i].kind === EntryKind.FileLink) fileLinks.push(file);
  });
  placeDirectories(repoRoot, directories, entries);

  for (const file of selection.deletedFiles) {
    const stat = await fs.lstat(path.join(realRoot, file)).catch(() => undefined);
    // fails-when: a dangling tracked link is listed as a plain deletion with no warning
    if (stat?.isSymbolicLink()) entries.skipped.danglingLinks.push(file);
  }
  return { entries, place, fileLinks, realRoot, linkedDirs };
}

/**
 * Sort the selection into content, directory symlinks, deletions and skips. `kici run --local`
 * uses it as is: its `HEAD` clone holds every unchanged link target and it recreates links. A
 * dangling tracked link stays a deletion and is recorded for the CLI to name.
 */
export async function classifySelection(
  repoRoot: string,
  selection: SelectedPaths,
): Promise<OverlayEntries> {
  return (await classify(repoRoot, selection)).entries;
}

/**
 * `classifySelection`, plus the targets the agent dereferences each file symlink through. A link
 * whose target cannot ship moves to `skipped.unshippedLinks`, skip-worktree in the remote index.
 *
 * @param isIgnored - The `.kiciignore` matcher; a link target it matches is not shipped
 */
export async function classifyOverlayEntries(
  repoRoot: string,
  selection: SelectedPaths,
  isIgnored: (file: string) => boolean,
): Promise<OverlayEntries> {
  const { entries, place, fileLinks, realRoot, linkedDirs } = await classify(repoRoot, selection);
  const outsideDirs = await outsideDirLinks(realRoot, Object.keys(entries.symlinks));
  for (const link of outsideDirs) delete entries.symlinks[link];
  const shipped = new Set([...entries.files, ...Object.keys(entries.symlinks)]);
  const { targets, unshipped } = await linkTargets(
    repoRoot,
    realRoot,
    fileLinks,
    shipped,
    isIgnored,
  );
  if (unshipped.length > 0) {
    const skip = new Set(unshipped);
    entries.files = entries.files.filter((file) => !skip.has(file));
  }
  entries.skipped.unshippedLinks.push(...[...unshipped, ...outsideDirs].sort());
  for (const extra of targets) place(extra, await classifyPath(realRoot, extra, linkedDirs));
  return entries;
}

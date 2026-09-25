/**
 * Symbolic links in the overlay the CLI uploads.
 *
 * A file symlink ships as a link entry whose manifest checksum covers the file
 * it points at, and the agent dereferences it inside the extracted overlay. So
 * every in-repository link on the way, and the regular file it lands on, ship
 * with it even when they did not change. A symlink whose target is a directory
 * is not content: it ships as its link text in the manifest's `symlinks` map,
 * and the agent recreates it.
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
  /** Submodules (gitlinks in the index): their files are not uploaded. */
  submodules: string[];
  /** Untracked nested git repositories: their files are not uploaded. */
  nestedRepositories: string[];
  /** Tracked symlinks whose target does not exist: absent from the remote workspace. */
  danglingLinks: string[];
}

/** How the overlay ships each selected path. */
export interface OverlayEntries {
  /** Regular files and file symlinks: shipped as content and checksummed. */
  files: string[];
  /** Symlinks whose target is a directory: repo-relative path → link text. */
  symlinks: Record<string, string>;
  /** Paths the agent removes. */
  deletions: string[];
  /** What the overlay leaves out on purpose. */
  skipped: OverlaySkipped;
}

/** The paths a selection partitions into, as `selectOverlayFiles` returns them. */
interface SelectedPaths {
  existingFiles: string[];
  deletedFiles: string[];
}

/** What one path on disk is, as far as the overlay is concerned. */
enum EntryKind {
  File = 'file',
  FileLink = 'fileLink',
  DirLink = 'dirLink',
  BeneathLink = 'beneathLink',
  Directory = 'directory',
}

/** What one path on disk is, with the link text of a directory symlink. */
type PathKind =
  | { kind: EntryKind.File }
  | { kind: EntryKind.FileLink }
  | { kind: EntryKind.DirLink; text: string }
  | { kind: EntryKind.BeneathLink }
  | { kind: EntryKind.Directory };

/** True for repo-relative paths inside the `.git` directory. */
export function isGitDirPath(relPath: string): boolean {
  return relPath === '.git' || relPath.startsWith('.git/');
}

/**
 * Whether the repo-relative directory `dir`, or a directory above it, is a
 * symlink. Memoized per directory, since every file in a directory asks.
 */
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
  // git tracks nothing beneath a symlink: a path listed there (a directory the
  // developer replaced with a link) is gone, even though it reads through the
  // link. `.git` is walked by the uploader itself, not listed by git.
  if (!isGitDirPath(file) && (await dirIsLinked(realRoot, path.posix.dirname(file), linkedDirs))) {
    return { kind: EntryKind.BeneathLink };
  }
  const full = path.join(realRoot, file);
  const stat = await fs.lstat(full).catch(() => undefined);
  // A real directory is never content: a submodule, a nested repository, or a
  // tracked file or link the developer replaced with a directory.
  if (stat?.isDirectory()) return { kind: EntryKind.Directory };
  if (!stat?.isSymbolicLink()) return { kind: EntryKind.File };
  const target = await fs.stat(full).catch(() => undefined);
  if (target?.isDirectory()) return { kind: EntryKind.DirLink, text: await fs.readlink(full) };
  return { kind: EntryKind.FileLink };
}

/**
 * Follow the file symlink `linkRel` one path component at a time, the way the
 * kernel resolves it, and return every symlink met after it plus the regular
 * file it lands on — all repo-relative and free of symlinked directories. Null
 * when the chain leaves the repository, uses an absolute link text (which the
 * agent resolves against its own host), loops, or ends on anything but a
 * regular file: the agent refuses such a link, and nothing ships for it.
 */
async function followLinkChain(
  realRoot: string,
  linkRel: string,
): Promise<{ hops: string[]; target: string } | null> {
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
  if (!last?.isFile()) return null;
  return { hops, target: resolved };
}

/**
 * The subset of `paths` git would ship: tracked, or untracked and not ignored.
 * A link must never carry a gitignored file (such as `.kici/.env.local`) into
 * the upload just because a tracked link points at it.
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
 * The in-repository links and files the selected file symlinks resolve
 * through, minus what already ships and what git or `.kiciignore` excludes.
 */
async function linkTargets(
  repoRoot: string,
  realRoot: string,
  fileLinks: string[],
  shipped: Set<string>,
  isIgnored: (file: string) => boolean,
): Promise<string[]> {
  const wanted = new Set<string>();
  for (const link of fileLinks) {
    const chain = await followLinkChain(realRoot, link);
    if (!chain) continue;
    for (const p of [...chain.hops, chain.target]) if (!shipped.has(p)) wanted.add(p);
  }
  if (wanted.size === 0) return [];
  const shippable = gitShippable(repoRoot, [...wanted]);
  return [...wanted].filter((p) => shippable.has(p) && !isIgnored(p));
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
  // Each entry reads `<mode> <object> <stage>\t<path>`. A pathspec also matches
  // everything beneath a directory, so only an exact path counts.
  for (const entry of out.split('\0')) {
    const tab = entry.indexOf('\t');
    const file = entry.slice(tab + 1);
    if (tab > 0 && entry.startsWith(`${GITLINK_MODE} `) && wanted.has(file)) found.add(file);
  }
  return found;
}

/**
 * Sort the selected real directories. A submodule, or an untracked nested
 * repository (which git lists with a trailing slash), is skipped: its files are
 * not uploaded. Any other directory replaced a tracked file or symlink, so that
 * path is a deletion; its files ship as untracked files.
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

/** Which run the skipped paths are left out of, which decides the warning's wording. */
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

/**
 * The CLI warnings for what the overlay left out, one per kind, naming every
 * path.
 */
export function overlaySkipWarnings(skipped: OverlaySkipped, context: SkipContext): string[] {
  const { verb, where } = SKIP_WORDING[context];
  const kinds: Array<[string[], string]> = [
    [skipped.submodules, 'the files of these submodules'],
    [skipped.nestedRepositories, 'the files of these nested git repositories'],
    [skipped.danglingLinks, 'these symbolic links, whose target does not exist'],
  ];
  return kinds
    .filter(([paths]) => paths.length > 0)
    .map(
      ([paths, what]) => `${verb} ${what}: ${paths.join(', ')}. ${where} does not contain them.`,
    );
}

/** What one path is placed as, keyed by the kind `classifyPath` found. */
type Placer = (file: string, kind: PathKind) => void;

/** A classified selection, plus what adding link targets needs from it. */
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
    skipped: { submodules: [], nestedRepositories: [], danglingLinks: [] },
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
 * Sort the selected paths into what ships as content (regular files and file
 * symlinks), what ships as a directory symlink, what is deleted, and what is
 * skipped. Used as it is by `kici run --local`, whose clone at `HEAD` already
 * holds every unchanged link target and which recreates each link as a link.
 *
 * A tracked symlink whose target does not exist reads as missing, so the
 * selection already lists it as a deletion; it stays one (the workspace lacks
 * the path, as a read through the link would find), and it is recorded so the
 * CLI can name it.
 */
export async function classifySelection(
  repoRoot: string,
  selection: SelectedPaths,
): Promise<OverlayEntries> {
  return (await classify(repoRoot, selection)).entries;
}

/**
 * Classify the selection as `classifySelection` does, then add the targets the
 * selected file symlinks need on the agent, which dereferences each file
 * symlink inside the extracted overlay.
 *
 * @param isIgnored - The `.kiciignore` matcher; a link target it matches is not shipped
 */
export async function classifyOverlayEntries(
  repoRoot: string,
  selection: SelectedPaths,
  isIgnored: (file: string) => boolean,
): Promise<OverlayEntries> {
  const { entries, place, fileLinks, realRoot, linkedDirs } = await classify(repoRoot, selection);
  const shipped = new Set([...entries.files, ...Object.keys(entries.symlinks)]);
  for (const extra of await linkTargets(repoRoot, realRoot, fileLinks, shipped, isIgnored)) {
    place(extra, await classifyPath(realRoot, extra, linkedDirs));
  }
  return entries;
}

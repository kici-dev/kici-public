/**
 * The one definition of "this `.kici/` tree's content".
 *
 * The compiler writes it into the lock file as a workflow's `contentHash`
 * input; the agent recomputes it over the extracted tree as the drift gate. One
 * implementation, imported by both, is what makes those two numbers comparable
 * — a second copy is how a producer and its verifier drift apart.
 *
 * The digest covers the whole directory because the artifact it names is the
 * whole directory: `source-packer.ts` packs all of `.kici/` minus
 * `.kici/node_modules/`. Hashing only the workflow entry file left the identity
 * covering one file while the object it keyed covered a tree, so editing an
 * imported helper — `.kici/lib/deploy.ts` under `.kici/workflows/deploy.ts` —
 * moved no hash, hit the source cache, restored the previous tarball, ran the
 * OLD helper, and reported green. The drift gate could not catch it either,
 * because it re-hashed the same single file.
 *
 * Which files it covers is **declared**, not hard-coded: `.kici/.kiciignore`
 * replaces the default exclusion set when present, and `kici-ignore.ts` holds
 * both the defaults and the matcher. That file explains why the set had to
 * become declarative — the agent rewrites `package-lock.json` and `.npmrc`
 * inside the tree it is asked to re-hash.
 *
 * Determinism, in the order it matters:
 *
 * - **Sorted** by repo-relative POSIX path, so directory-read order never
 *   reaches the hash.
 * - **`.kici/`-prefixed** paths, byte-identical to the tar member names, so the
 *   `node_modules` exclusion here and in `source-packer.ts` are the same
 *   predicate. The tarball is a superset of what the digest covers: it carries
 *   `kici.lock.json`, whatever `.kici/types/` the packing clone held, and any
 *   other path `.kiciignore` excludes.
 * - **Line-ending normalized**, so a Windows agent whose checkout carries CRLF
 *   agrees with a Linux compiler's LF. Same normalization the single-file hash
 *   has always applied.
 * - **`\0`-delimited** path and content, so no rename can be disguised as a
 *   content edit (`a/bc` + `d` and `a/b` + `cd` hash differently).
 *
 * A symlink contributes its target string, never the bytes behind it. That is
 * what keeps the walk terminating, and it is why the exclusion set resolves a
 * link to decide whether a directory-only pattern covers it — see
 * `matchesAsDirectory`. It also bounds which links are safe to hash at all:
 * only one whose target survives pack → extract unchanged, which
 * `findDigestReproducibilityWarnings` checks against the tree the compiler is
 * about to hash.
 */

import fs from 'node:fs/promises';
import type { Dirent } from 'node:fs';
import path from 'node:path';
import { normalizeLineEndings, sha256 } from './crypto.js';
import {
  KICI_DIGEST_DEFAULT_EXCLUSIONS,
  KICI_DIGEST_FORCED_EXCLUSIONS,
  KICI_DIGEST_FORCED_INCLUSIONS,
  KICI_IGNORE_FILENAME,
  KICI_RUN_REWRITTEN_PATHS,
  buildKiciIgnoreMatcher,
  findUncoveredRunRewrittenPaths,
  parseKiciIgnore,
  runRewrittenWarning,
} from './kici-ignore.js';

// Re-exported through this module because it is the one the compiler and agent
// already import; `.kiciignore` is a property of the digest, so a consumer
// should not need a second entry point to describe it.
export {
  KICI_DIGEST_DEFAULT_EXCLUSIONS,
  KICI_DIGEST_FORCED_EXCLUSIONS,
  KICI_DIGEST_FORCED_INCLUSIONS,
  KICI_IGNORE_FILENAME,
  KICI_RUN_REWRITTEN_PATHS,
} from './kici-ignore.js';

/** The resolved exclusion rules for one `.kici/` tree. */
export interface KiciIgnoreRules {
  /**
   * `'file'` when `.kici/.kiciignore` supplied the patterns, `'default'` when
   * it was absent. Replace semantics live in this distinction: a file that
   * exists IS the list, and the defaults do not merge into it.
   */
  readonly source: 'file' | 'default';
  /** The declared patterns, exactly as parsed. Forced entries are not in here. */
  readonly patterns: readonly string[];
  /** Excluded regardless of what the patterns say. */
  readonly forced: readonly string[];
  /** Run-rewritten paths the patterns fail to cover, sorted. */
  readonly missingRunRewritten: readonly string[];
  /** One human-readable warning per entry of `missingRunRewritten`. */
  readonly warnings: readonly string[];
}

/**
 * Compile schema version — bump when the compilation approach changes (what the
 * digest covers, how the hash input is built, the artifact model).
 * This is NOT the lock file schema version.
 *
 * It lives here, beside the digest it qualifies, because the compiler that
 * writes a `contentHash` and the agent that re-verifies it must mix in the same
 * number or every hash disagrees. `@kici-dev/compiler` `lockfile/hasher.ts` and
 * `@kici-dev/agent` `execution/workflow-loader.ts` both re-export this one
 * definition — a second copy is how a producer and its verifier drift apart,
 * which is the same reason `hashKiciSourceTree` above is single-sourced.
 *
 * What each version means:
 *
 * - 3 → 4: the agent artifact switched from a Rolldown-bundled `.compiled.mjs`
 *   to a raw `.kici/` source tarball extracted and imported via the shared
 *   oxc-transform ESM loader hook.
 * - 4 → 5: the hash input became line-ending-normalized (CRLF → LF) so a lock
 *   produced on Linux matches a Windows agent's checkout.
 * - 5 → 6: `bundleSource` became a digest over the whole `.kici/` tree
 *   (`hashKiciSourceTree`) rather than the workflow entry file's text, so the
 *   identity covers the same files the source tarball carries.
 * - 6 → 7: the covered set became declarative — `.kici/.kiciignore` — and the
 *   default exclusions grew to cover `.npmrc`, `package-lock.json` and
 *   `pnpm-lock.yaml`. A run rewrites those inside the very tree the agent must
 *   re-hash, so the previous set covered files the agent itself changed and the
 *   drift gate rejected runs whose source had not moved. Every repo's
 *   `contentHash` therefore moves; old lock files are stale and are regenerated
 *   by `kici compile`.
 */
export const COMPILE_SCHEMA_VERSION = 7;

/**
 * Resolve the exclusion rules for `kiciDir`, reading `.kici/.kiciignore`.
 *
 * Separate from `hashKiciSourceTree` because the compiler needs the warnings
 * without needing a digest — and because a caller that wants to explain the
 * exclusion set should not have to re-implement how it was chosen.
 *
 * An unreadable file falls back to the defaults: the digest's job is to be
 * computable, and a read failure that silently emptied the exclusion set would
 * make every subsequent run drift instead.
 */
export async function loadKiciIgnoreRules(kiciDir: string): Promise<KiciIgnoreRules> {
  let patterns: readonly string[] = KICI_DIGEST_DEFAULT_EXCLUSIONS;
  let source: 'file' | 'default' = 'default';

  try {
    const content = await fs.readFile(path.join(kiciDir, KICI_IGNORE_FILENAME), 'utf-8');
    patterns = parseKiciIgnore(content);
    source = 'file';
  } catch {
    // Absent or unreadable — the defaults stand.
  }

  // The defaults cover every run-rewritten path by construction, so only a
  // hand-written file can warn.
  const missingRunRewritten = source === 'file' ? findUncoveredRunRewrittenPaths(patterns) : [];

  return {
    source,
    patterns,
    forced: KICI_DIGEST_FORCED_EXCLUSIONS,
    missingRunRewritten,
    warnings: missingRunRewritten.map(runRewrittenWarning),
  };
}

/**
 * The one directory inside `.kici/` the source **tarball** omits — installed
 * dependencies ship in the deps tarball instead. Stated as the tar member
 * prefix so this and `source-packer.ts`'s filter test the same string.
 *
 * This governs the tarball, not the digest. The digest's exclusion set is
 * declared in `.kici/.kiciignore` (defaults in `kici-ignore.ts`), which covers
 * `node_modules/` among others — so the tarball stays a superset of the hashed
 * set, as it always was for `kici.lock.json`.
 */
export const KICI_SOURCE_EXCLUDED_PREFIX = '.kici/node_modules';

/**
 * The compiler's own output, which lives inside the directory it hashes.
 *
 * Retained as the `.kici/`-prefixed tar member name; the digest enforces this
 * exclusion through `KICI_DIGEST_FORCED_EXCLUSIONS`, which no `.kiciignore` can
 * switch off, for the reason spelled out below.
 *
 * Excluding it is not a relaxation — it is the only way the digest can exist.
 * The compiler walks `.kici/` to compute a workflow's `contentHash`, then
 * writes that hash INTO `.kici/kici.lock.json`; an agent walking the extracted
 * tree afterwards would see the new lock file and compute a different digest,
 * so the drift gate would reject every run. The input to a hash cannot contain
 * the hash. `lockfileHash` has always had the same shape and avoids it the same
 * way, by naming exactly one file rather than a tree.
 *
 * The lock file still ships in the tarball, and its own integrity comes from
 * elsewhere: the orchestrator fetches it at the commit SHA, so it is provenance
 * that vouches for it, never `contentHash`.
 */
export const KICI_SOURCE_EXCLUDED_LOCK = '.kici/kici.lock.json';

/**
 * The compiler's generated type declarations, for the same reason and one more.
 *
 * Retained as the `.kici/`-prefixed tar member prefix; the digest excludes it
 * through the `types/` entry of `KICI_DIGEST_DEFAULT_EXCLUSIONS`, which a
 * `.kiciignore` may override — the reasons below are strong but, unlike the
 * lock file's, not arithmetic.
 *
 * `kici compile` refreshes `.kici/types/secrets.d.ts` after it has already
 * hashed the tree, so the ordering problem above applies verbatim. The stronger
 * reason is that `kici init` gitignores `.kici/types/`: the declarations are a
 * per-developer snapshot of one org's secret keys, never committed. So the
 * directory exists on the machine that compiles and is absent from the clone
 * the agent hashes — the two digests could not agree even if nothing wrote
 * during the compile.
 *
 * Excluding it costs the gate nothing: a `.d.ts` is erased before anything
 * runs, so no behavior it could describe reaches a job.
 */
export const KICI_SOURCE_EXCLUDED_TYPES_PREFIX = '.kici/types/';

/**
 * Whether the exclusion patterns should see this entry as a directory.
 *
 * `Dirent.isDirectory()` describes the link itself, so a symlinked
 * `.kici/node_modules` reads as a file and the directory-only `node_modules/`
 * pattern misses it. The compiler then hashes a `symlink:<target>` member that
 * no agent can hold: the tarball drops `.kici/node_modules` by prefix, and the
 * restore materialises a real directory the exclusion does match. The producer
 * and its verifier disagree on a tree nobody edited, and recompiling reproduces
 * the same lock.
 *
 * So classification resolves the link and the walk does not. An entry that
 * survives exclusion is still recorded as a member and still contributes its
 * target string; nothing here follows a link to read what is behind it, which
 * is what keeps the walk terminating and keeps the hashed set equal to what the
 * tarball carries.
 *
 * A link that cannot be resolved — dangling, cyclic (the kernel's own
 * `ELOOP`), or unreadable — is a file, which is what it contributes anyway.
 *
 * This is a deliberate deviation from gitignore, where `node_modules/` does not
 * match a symlinked `node_modules`. The purpose of the entry is "exclude the
 * dependency tree, whatever shape it takes on disk", and a link to the
 * dependency tree is the dependency tree.
 */
async function matchesAsDirectory(abs: string, entry: Dirent): Promise<boolean> {
  if (entry.isDirectory()) return true;
  if (!entry.isSymbolicLink()) return false;
  try {
    return (await fs.stat(abs)).isDirectory();
  } catch {
    return false;
  }
}

/** Every file the source tarball carries, as `.kici/`-prefixed POSIX paths. */
async function collectSourcePaths(kiciDir: string, rules: KiciIgnoreRules): Promise<string[]> {
  const found: string[] = [];
  const isExcluded = buildKiciIgnoreMatcher(rules.patterns);
  const isForced = buildKiciIgnoreMatcher(rules.forced);

  async function walk(absDir: string, relDir: string): Promise<void> {
    const entries = await fs.readdir(absDir, { withFileTypes: true });
    for (const entry of entries) {
      const rel = relDir ? `${relDir}/${entry.name}` : entry.name;
      const member = `.kici/${rel}`;
      const abs = path.join(absDir, entry.name);
      const asDir = await matchesAsDirectory(abs, entry);
      // Forced inclusion outranks every exclusion, so the file that declares
      // the exclusion set can never remove itself from the identity.
      const pinned = !asDir && KICI_DIGEST_FORCED_INCLUSIONS.includes(rel);
      if (!pinned && (isForced(rel, asDir) || isExcluded(rel, asDir))) continue;
      if (entry.isDirectory()) {
        await walk(abs, rel);
      } else {
        // Files and symlinks alike. A symlink contributes its target string
        // rather than its target's bytes, which keeps the walk terminating and
        // still moves the digest when the link is repointed.
        found.push(member);
      }
    }
  }

  await walk(kiciDir, '');
  return found.sort();
}

/**
 * Read one member's contribution. A symlink contributes its target; a file its
 * text. An unreadable entry contributes the empty string rather than throwing —
 * the digest's job is to change when the tree changes, and a read failure is
 * reported by the tar step that follows, not here.
 */
async function readMember(abs: string): Promise<string> {
  const stat = await fs.lstat(abs);
  if (stat.isSymbolicLink()) return `symlink:${await fs.readlink(abs)}`;
  return fs.readFile(abs, 'utf-8');
}

/**
 * SHA-256 over every file in `kiciDir`, excluding `.kici/node_modules/`.
 *
 * Returns the empty string when the directory does not exist, which the callers
 * treat exactly as they already treat an unreadable entry file: no hash, so no
 * drift gate.
 */
export async function hashKiciSourceTree(kiciDir: string): Promise<string> {
  let members: string[];
  try {
    members = await collectSourcePaths(kiciDir, await loadKiciIgnoreRules(kiciDir));
  } catch {
    return '';
  }

  const parts: string[] = [];
  for (const member of members) {
    const abs = path.join(kiciDir, member.slice('.kici/'.length));
    let content: string;
    try {
      content = await readMember(abs);
    } catch {
      content = '';
    }
    parts.push(`${member}\0${normalizeLineEndings(content)}\0`);
  }
  return sha256(parts.join(''));
}

/** One symlink in the hashed member set, with the link string it contributes. */
export interface SourceSymlink {
  /** The `.kici/`-prefixed member name, as the digest and the tarball spell it. */
  readonly member: string;
  /** The link string, verbatim — which is what the digest hashes. */
  readonly target: string;
}

/**
 * Why a symlink member's link string cannot survive pack → extract, or null
 * when it can.
 *
 * The digest hashes a symlink as its target string, so the two sides agree only
 * when the tarball carries that exact string through to the agent. Measured
 * against the packer's `tarCreate` and the restore's `tarExtract` options:
 *
 * - `'absolute'` — extraction strips the leading `/`, so the producer hashes
 *   `symlink:/opt/x` and the agent hashes `symlink:opt/x`.
 * - `'escapes'` — a relative target resolving above the archive root is dropped
 *   outright by node-tar's link-escape protection, so the agent has no such
 *   path at all.
 *
 * Both are computable from the link string and the member path alone, which is
 * what lets the compiler warn without packing anything.
 */
export type SymlinkPackFault = 'absolute' | 'escapes';

/** Classify one symlink member against the pack → extract round trip. */
export function symlinkPackFault(member: string, target: string): SymlinkPackFault | null {
  if (target.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(target)) return 'absolute';
  // Members are `.kici/…`, and the tarball's root is the directory holding
  // `.kici`, so resolve the link there and ask whether it climbs out.
  const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(member), target));
  return resolved === '..' || resolved.startsWith('../') ? 'escapes' : null;
}

/**
 * Every symlink the digest hashes, in member order.
 *
 * Reads the same member set the digest does, so a link an exclusion covers is
 * absent here for the same reason it is absent from the hash.
 */
export async function collectSourceSymlinks(
  kiciDir: string,
  rules?: KiciIgnoreRules,
): Promise<SourceSymlink[]> {
  let members: string[];
  try {
    members = await collectSourcePaths(kiciDir, rules ?? (await loadKiciIgnoreRules(kiciDir)));
  } catch {
    return [];
  }

  const found: SourceSymlink[] = [];
  for (const member of members) {
    const abs = path.join(kiciDir, member.slice('.kici/'.length));
    try {
      if ((await fs.lstat(abs)).isSymbolicLink()) {
        found.push({ member, target: await fs.readlink(abs) });
      }
    } catch {
      // Vanished between the walk and the read — the digest treats it as empty
      // and the tar step that follows reports it.
    }
  }
  return found;
}

/** Does `rel`, relative to `.kici/`, name or live under a run-rewritten path? */
function underRunRewritten(rel: string): string | undefined {
  return KICI_RUN_REWRITTEN_PATHS.find((target) => {
    if (!target.endsWith('/')) return rel === target;
    const dir = target.slice(0, -1);
    return rel === dir || rel.startsWith(`${dir}/`);
  });
}

/**
 * Warnings about members the agent cannot reproduce, read off the actual tree.
 *
 * `findUncoveredRunRewrittenPaths` interrogates the *patterns* with a synthetic
 * directory probe and never consults the filesystem, so it is structurally
 * blind to a shape mismatch: a `.kici/node_modules` that is a dangling link, or
 * a link to a file, classifies as a file, escapes the directory-only
 * `node_modules/` entry, and is hashed — while the tarball omits it by prefix
 * and the agent's tree never holds it. This walks the tree instead.
 *
 * Two faults, both of which end in the same unrecoverable place — a lock the
 * agent rejects and a recompile that reproduces it:
 *
 * - a hashed member that is, or lies under, a path a run rewrites;
 * - a hashed symlink whose target cannot survive pack → extract.
 *
 * A run-rewritten member whose pattern set already earned a
 * `runRewrittenWarning` is left to that warning rather than named twice.
 */
export async function findDigestReproducibilityWarnings(
  kiciDir: string,
  rules?: KiciIgnoreRules,
): Promise<string[]> {
  const resolved = rules ?? (await loadKiciIgnoreRules(kiciDir));

  let members: string[];
  try {
    members = await collectSourcePaths(kiciDir, resolved);
  } catch {
    return [];
  }

  const warnings: string[] = [];
  for (const member of members) {
    const target = underRunRewritten(member.slice('.kici/'.length));
    if (!target || resolved.missingRunRewritten.includes(target)) continue;
    warnings.push(
      `${member} is covered by the digest even though '${target}' is excluded — the ` +
        `exclusion is directory-only and this entry is not a directory. A run rewrites ` +
        `'${target}' inside .kici/ before the agent re-hashes the tree, so the agent can ` +
        `never compute this hash and 'kici compile' cannot repair it. Replace the entry ` +
        `with a real directory, remove it, or exclude it by name in .kici/.kiciignore.`,
    );
  }

  for (const { member, target } of await collectSourceSymlinks(kiciDir, resolved)) {
    const fault = symlinkPackFault(member, target);
    if (!fault) continue;
    const why =
      fault === 'absolute'
        ? `its target is absolute and extraction strips the leading '/'`
        : `its target resolves outside the source tarball and extraction drops such a link`;
    warnings.push(
      `${member} is a symlink to '${target}' that the source tarball cannot carry ` +
        `unchanged: ${why}. The digest hashes a symlink as its target string, so the agent ` +
        `re-hashes a tree without it and rejects the run — and 'kici compile' cannot repair ` +
        `it. Point the link inside .kici/, replace it with the files it names, or exclude ` +
        `it in .kici/.kiciignore.`,
    );
  }

  return warnings;
}

/**
 * The sentence a drift error adds when the hashed tree carries symlinks.
 *
 * "Run 'kici compile'" is the right remedy for ordinary drift and is actively
 * misleading here: a symlink the tarball omits or extraction rewrites makes the
 * producer's hash unreachable on this side, so recompiling reproduces the same
 * lock forever. Naming the links turns an unrecoverable loop into something the
 * error text alone explains. Empty when the tree carries none, so an ordinary
 * drift error is unchanged.
 */
export function hashedSymlinkDriftNote(symlinks: readonly SourceSymlink[]): string {
  if (symlinks.length === 0) return '';
  const named = symlinks.map(({ member, target }) => `${member} -> ${target}`).join(', ');
  return (
    ` The hashed .kici/ tree carries ${symlinks.length} ` +
    `symlink${symlinks.length === 1 ? '' : 's'} (${named}). A symlink is hashed as its ` +
    `target string, not the bytes behind it, so a link the source tarball omits or ` +
    `extraction rewrites cannot reproduce the compiling machine's hash and recompiling ` +
    `will not change that. Remove it from .kici/, or exclude it in .kici/.kiciignore.`
  );
}

/**
 * Locate the `.kici` directory a workflow file lives under, or null when it
 * does not live under one (a config file outside the convention). Walks
 * ancestors rather than taking the directory as a parameter, so every entry
 * point that loads a workflow module resolves the same tree without threading
 * one more argument through each of them.
 */
export function findKiciDir(entryPath: string): string | null {
  let dir = path.dirname(path.resolve(entryPath));
  for (;;) {
    if (path.basename(dir) === '.kici') return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

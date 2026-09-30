/**
 * User-facing cache engine (sandbox-side).
 *
 * Packs `CacheSpec.paths` into a gzip tarball (mirrors dep-packer's tar+sha256
 * approach) and restores a tarball by downloading it to a temp file and
 * verifying its SHA-256 before extracting (as dep-restore does). Drives the
 * orchestrator over an injected request-response transport (IPC -> agent WS ->
 * orchestrator).
 *
 * Path safety: each path is either `~`-prefixed (home-relative) or
 * repo-root-relative; absolute paths and `..` escapes are rejected so a
 * workflow cannot exfiltrate or clobber files outside its tree/home.
 *
 * Multi-root layout: a spec may mix repo-relative and home-relative paths.
 * Each entry is staged under an anchor prefix — `__repo__/<rel>` for
 * repo-root-relative entries, `__home__/<rel>` for `~`-prefixed entries — so a
 * single tarball can carry both roots and extract restores each group to the
 * right destination (repo entries under `workDir`, home entries under the
 * homedir). Extraction lands in a scratch dir first, then moves each group
 * into place so a partial restore never leaves half-written paths in the live
 * tree (mirrors dep-restore). The scratch dir honors `KICI_TMPDIR`, which may
 * sit on a different filesystem from the workspace, so the move falls back to
 * copy-then-remove on `EXDEV` rather than assuming a same-filesystem rename.
 */
import { Readable } from 'node:stream';
import { homedir } from 'node:os';
import { isAbsolute, dirname, join, relative, resolve, sep } from 'node:path';
import { cp, mkdir, readdir, rename, rm } from 'node:fs/promises';
import { makeTempDir } from '@kici-dev/core/tmp';
import { REPO_ANCHOR, HOME_ANCHOR } from '@kici-dev/core';
import { c as tarCreate, x as tarExtract } from 'tar';
import { createLogger, sha256 } from '@kici-dev/shared';
import type { CacheSpec, CacheRestoreResult } from '@kici-dev/sdk';
import { downloadToFile } from '../resumable-download.js';
import { extractTarballFile, sha256File } from '../tarball-file.js';

const logger = createLogger({ prefix: 'cache-engine' });

/** Bound on extracting a downloaded cache tarball; matches the dependency restore's. */
const EXTRACT_TIMEOUT_MS = 10 * 60 * 1000;

/** Override roots — exposed for tests so the home destination is sandboxable. */
export interface CacheRoots {
  /** Home root override (defaults to `os.homedir()`). */
  home?: string;
}

/**
 * Resolve a cache path. `~`-prefixed -> home root; otherwise repo-root-relative.
 * Rejects absolute paths and `..` escapes so a workflow cannot read or clobber
 * files outside its tree / home.
 */
export function resolveCachePath(workDir: string, p: string, roots?: CacheRoots): string {
  const home = roots?.home ?? homedir();
  if (p === '~' || p.startsWith('~/')) {
    const rel = p === '~' ? '' : p.slice(2);
    return rel ? join(home, rel) : home;
  }
  if (isAbsolute(p)) throw new Error(`cache path must be repo-relative or ~-prefixed: ${p}`);
  const resolved = resolve(workDir, p);
  const rel = relative(workDir, resolved);
  if (rel === '..' || rel.startsWith(`..${sep}`)) {
    throw new Error(`cache path escapes the repo root: ${p}`);
  }
  return resolved;
}

interface AnchoredEntry {
  /** Source absolute path of the cached entry. */
  abs: string;
  /** Anchor prefix (`__repo__` / `__home__`) the entry stores under. */
  anchor: string;
  /** Path relative to its anchor root. */
  rel: string;
}

/** Resolve + anchor every spec path; rejects escapes via resolveCachePath. */
function anchorEntries(workDir: string, paths: string[], roots?: CacheRoots): AnchoredEntry[] {
  const home = roots?.home ?? homedir();
  return paths.map((p) => {
    const abs = resolveCachePath(workDir, p, roots);
    const isHome = p === '~' || p.startsWith('~/');
    const anchorRoot = isHome ? home : workDir;
    return { abs, anchor: isHome ? HOME_ANCHOR : REPO_ANCHOR, rel: relative(anchorRoot, abs) };
  });
}

/**
 * Pack the spec's paths into a gzip tarball + its SHA-256.
 *
 * Each path is copied into a staging dir under its anchor prefix
 * (`__repo__/<rel>` or `__home__/<rel>`), the staging dir is tarred (portable
 * mode strips uid/gid/mtime), and the staging dir is removed. The resulting
 * tarball self-describes which root each entry restores to.
 */
export async function packCachePaths(
  workDir: string,
  paths: string[],
  roots?: CacheRoots,
): Promise<{ tarball: Buffer; hash: string }> {
  const entries = anchorEntries(workDir, paths, roots);
  const { path: staging, cleanup } = await makeTempDir('cache-pack');
  try {
    const topLevel = new Set<string>();
    for (const e of entries) {
      const dest = join(staging, e.anchor, e.rel);
      await mkdir(dirname(dest), { recursive: true });
      // Copy preserving symlinks-as-symlinks (verbatimSymlinks) so a cached
      // link graph restores intact, matching dep-packer's follow:false intent.
      await cp(e.abs, dest, { recursive: true, verbatimSymlinks: true });
      topLevel.add(e.anchor);
    }
    const stream = tarCreate({ gzip: true, portable: true, cwd: staging }, [...topLevel]);
    const chunks: Buffer[] = [];
    for await (const chunk of stream as AsyncIterable<Uint8Array>) {
      chunks.push(Buffer.from(chunk));
    }
    const tarball = Buffer.concat(chunks);
    const hash = sha256(tarball);
    logger.info('packed user cache', { sizeBytes: tarball.length, hash: hash.slice(0, 12), paths });
    return { tarball, hash };
  } finally {
    await cleanup();
  }
}

/**
 * Move a tree from `src` to `dest`. Attempts a rename (same-filesystem, cheap)
 * and falls back to copy-then-remove only on `EXDEV` — the errno `rename(2)`
 * reports when the scratch dir (which honors `KICI_TMPDIR`) is on a different
 * filesystem from the destination workspace. `verbatimSymlinks` keeps a cached
 * symlink graph intact (mirroring packCachePaths), and `preserveTimestamps`
 * keeps mtimes stable so the fallback is byte-for-byte equivalent to the
 * rename. Any non-`EXDEV` error propagates so a real permission or corruption
 * failure is never silently turned into a copy.
 */
async function moveOrCopy(src: string, dest: string): Promise<void> {
  try {
    await rename(src, dest);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EXDEV') throw err;
    await cp(src, dest, { recursive: true, verbatimSymlinks: true, preserveTimestamps: true });
    await rm(src, { recursive: true, force: true });
  }
}

/** Move the extracted `__repo__` / `__home__` groups from a scratch dir into place. */
async function moveAnchoredGroups(
  scratchDir: string,
  workDir: string,
  home: string,
): Promise<void> {
  for (const anchor of await readdir(scratchDir)) {
    const anchorDir = join(scratchDir, anchor);
    const destRoot = anchor === HOME_ANCHOR ? home : anchor === REPO_ANCHOR ? workDir : null;
    if (!destRoot) continue; // ignore unexpected top-level entries (defensive)
    for (const child of await readdir(anchorDir)) {
      const dest = join(destRoot, child);
      await mkdir(dirname(dest), { recursive: true });
      await rm(dest, { recursive: true, force: true });
      await moveOrCopy(join(anchorDir, child), dest);
    }
  }
}

/**
 * Extract a cache tarball buffer, verifying its SHA-256 first, then move each
 * anchored group into place (repo entries under `workDir`, home entries under
 * the home root). Extracts into a scratch dir so a partial restore never
 * leaves half-written paths in the live tree.
 */
export async function extractCacheTarball(
  tarball: Buffer,
  workDir: string,
  expectedHash: string,
  roots?: CacheRoots,
): Promise<void> {
  const actual = sha256(tarball);
  if (actual !== expectedHash) {
    throw new Error(`Cache tarball checksum mismatch: expected ${expectedHash}, got ${actual}`);
  }
  const home = roots?.home ?? homedir();
  await mkdir(workDir, { recursive: true });
  const { path: scratch, cleanup } = await makeTempDir('cache-extract');
  try {
    await new Promise<void>((res, rej) => {
      Readable.from(tarball)
        .pipe(tarExtract({ cwd: scratch, gzip: true }))
        .on('finish', res)
        .on('error', rej);
    });
    await moveAnchoredGroups(scratch, workDir, home);
  } finally {
    await cleanup();
  }
}

/**
 * Remove a temp dir, logging instead of throwing. After an extraction that
 * failed or timed out, `tar` may still be writing into the scratch dir, and an
 * `ENOTEMPTY` from the removal must not replace the error that explains the
 * failure. A leftover sits under the temp root, outside the job's tree.
 */
async function cleanupQuietly(dir: { path: string; cleanup(): Promise<void> }): Promise<void> {
  try {
    await dir.cleanup();
  } catch (err) {
    logger.warn('Cache temp dir cleanup failed (left behind)', {
      path: dir.path,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Download a presigned URL into a temp file, verify its SHA-256, and only then
 * extract it and move the anchored groups into place. Downloading first keeps
 * a slow extraction from holding the connection open, where an object store
 * closing it would fail the restore, and nothing is extracted from unverified
 * bytes. The download retries and resumes a cut transfer
 * (`resumable-download.ts`); both temp dirs honor `KICI_TMPDIR` and are removed
 * whatever happens (a failed removal is logged, never thrown).
 */
export async function downloadAndExtractCache(
  url: string,
  workDir: string,
  expectedHash: string,
  roots?: CacheRoots,
): Promise<void> {
  const home = roots?.home ?? homedir();
  const download = await makeTempDir('cache-download');
  try {
    const tarPath = join(download.path, 'cache.tar.gz');
    try {
      await downloadToFile(url, tarPath);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`cache download failed: ${message}`, { cause: err });
    }
    const digest = await sha256File(tarPath);
    if (digest !== expectedHash) {
      throw new Error(
        `Cache tarball checksum mismatch on download: expected ${expectedHash}, got ${digest}`,
      );
    }
    await mkdir(workDir, { recursive: true });
    const scratch = await makeTempDir('cache-extract');
    try {
      await extractTarballFile(tarPath, scratch.path, EXTRACT_TIMEOUT_MS);
      await moveAnchoredGroups(scratch.path, workDir, home);
    } finally {
      await cleanupQuietly(scratch);
    }
  } finally {
    await cleanupQuietly(download);
  }
}

/**
 * Transport the cache engine uses to reach the orchestrator over IPC -> WS.
 * Backed by the agent's request/response relay (added to the IPC protocol in a
 * later wiring task).
 */
export interface CacheTransport {
  restore(
    key: string,
    restoreKeys?: string[],
  ): Promise<{ hit: boolean; matchedKey?: string; downloadUrl?: string; tarHash?: string }>;
  beginSave(key: string): Promise<{ skip: boolean; uploadUrl?: string }>;
  completeSave(key: string, tarHash: string, sizeBytes: number): Promise<void>;
}

/** Build the imperative `ctx.cache` API bound to a workDir + transport. */
export function createCacheApi(
  workDir: string,
  transport: CacheTransport,
  roots?: CacheRoots,
): {
  restore(spec: CacheSpec): Promise<CacheRestoreResult>;
  save(spec: CacheSpec): Promise<void>;
} {
  return {
    async restore(spec: CacheSpec): Promise<CacheRestoreResult> {
      const r = await transport.restore(spec.key, spec.restoreKeys);
      if (!r.hit || !r.downloadUrl || !r.tarHash) return { hit: false };
      await downloadAndExtractCache(r.downloadUrl, workDir, r.tarHash, roots);
      logger.info('user cache restored', { key: spec.key, matchedKey: r.matchedKey });
      return { hit: true, matchedKey: r.matchedKey };
    },
    async save(spec: CacheSpec): Promise<void> {
      const begin = await transport.beginSave(spec.key);
      if (begin.skip || !begin.uploadUrl) {
        logger.info('user cache save skipped (key exists)', { key: spec.key });
        return;
      }
      const { tarball, hash } = await packCachePaths(workDir, spec.paths, roots);
      const { uploadToPresignedUrl } = await import('../download.js');
      await uploadToPresignedUrl(begin.uploadUrl, tarball);
      await transport.completeSave(spec.key, hash, tarball.length);
      logger.info('user cache saved', { key: spec.key, sizeBytes: tarball.length });
    },
  };
}

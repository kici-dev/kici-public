/**
 * User-facing cache engine (sandbox-side).
 *
 * Packs `CacheSpec.paths` into a gzip tarball (mirrors dep-packer's tar+sha256
 * approach) and restores a tarball with on-the-fly SHA-256 verification
 * (mirrors dep-restore's streaming pipeline). Drives the orchestrator over an
 * injected request-response transport (IPC -> agent WS -> orchestrator).
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
 * tree (mirrors dep-restore).
 */
import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';
import { createGunzip } from 'node:zlib';
import { homedir, tmpdir } from 'node:os';
import { isAbsolute, dirname, join, relative, resolve, sep } from 'node:path';
import { cp, mkdir, mkdtemp, readdir, rename, rm } from 'node:fs/promises';
import { c as tarCreate, x as tarExtract } from 'tar';
import { createLogger, sha256 } from '@kici-dev/shared';
import type { CacheSpec, CacheRestoreResult } from '@kici-dev/sdk';

const logger = createLogger({ prefix: 'cache-engine' });

/** Download timeout for a presigned cache GET: 5 minutes. */
const DOWNLOAD_TIMEOUT_MS = 5 * 60 * 1000;

/** Anchor prefix for repo-root-relative cache entries inside the tar. */
const REPO_ANCHOR = '__repo__';
/** Anchor prefix for home-relative (`~`) cache entries inside the tar. */
const HOME_ANCHOR = '__home__';

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
  const staging = await mkdtemp(join(tmpdir(), 'kici-cache-pack-'));
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
    await rm(staging, { recursive: true, force: true });
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
      await rename(join(anchorDir, child), dest);
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
  const scratch = await mkdtemp(join(tmpdir(), 'kici-cache-extract-'));
  try {
    await new Promise<void>((res, rej) => {
      Readable.from(tarball)
        .pipe(tarExtract({ cwd: scratch, gzip: true }))
        .on('finish', res)
        .on('error', rej);
    });
    await moveAnchoredGroups(scratch, workDir, home);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

/**
 * Stream-download a presigned URL, verify its SHA-256 on the fly (mirrors
 * dep-restore's response -> hash -> gunzip -> tar pipeline), then move the
 * anchored groups into place. Extracts into a scratch dir so a failed download
 * never half-writes the live tree.
 */
export async function downloadAndExtractCache(
  url: string,
  workDir: string,
  expectedHash: string,
  roots?: CacheRoots,
): Promise<void> {
  const home = roots?.home ?? homedir();
  const response = await fetch(url, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
  if (!response.ok || !response.body) throw new Error(`cache download HTTP ${response.status}`);
  const hash = createHash('sha256');
  const hashTransform = new Transform({
    transform(chunk, _enc, cb) {
      hash.update(chunk);
      cb(null, chunk);
    },
  });
  await mkdir(workDir, { recursive: true });
  const scratch = await mkdtemp(join(tmpdir(), 'kici-cache-extract-'));
  try {
    // Cast: fetch() returns a DOM ReadableStream; Readable.fromWeb expects the
    // Node web-stream type. Structurally identical at runtime (same as dep-restore).
    await pipeline(
      Readable.fromWeb(response.body as never),
      hashTransform,
      createGunzip(),
      tarExtract({ cwd: scratch }),
    );
    const digest = hash.digest('hex');
    if (digest !== expectedHash) {
      throw new Error(
        `Cache tarball checksum mismatch on download: expected ${expectedHash}, got ${digest}`,
      );
    }
    await moveAnchoredGroups(scratch, workDir, home);
  } finally {
    await rm(scratch, { recursive: true, force: true });
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

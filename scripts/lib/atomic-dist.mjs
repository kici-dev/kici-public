/**
 * Atomic publish of a package's `dist/`.
 *
 * Clearing `dist/` before writing leaves a window in which a concurrent reader
 * (a CI agent in the same checkout, a second `pnpm build`, an editor's
 * TypeScript server, build-service.mjs reading a peer's dist/index.js) dies
 * with ERR_MODULE_NOT_FOUND.
 *
 * So the writer never clears. It stages into `<pkg>/dist.tmp-<pid>`, so two
 * builds of one package never share a staging tree, moves each artifact into
 * place with one rename(2) (atomic: the stage is a sibling of `dist/`, on the
 * same filesystem), and only then removes artifacts this run did not produce.
 *
 * The guarantee is per path, not per generation: a path still produced is
 * always readable (old bytes or new), a newly produced path exists before any
 * updated file that could import it is visible, and a dropped path is removed
 * only after every replacement is in place. A reader holding a
 * previous-generation module can still miss a content-hashed chunk it imported
 * (`rolldown-runtime-<hash>.js`) if the hash moved, but only for the
 * milliseconds between publish and prune.
 */
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';

/** Prefix of the per-process staging directory, a sibling of `dist/`. */
const STAGE_PREFIX = 'dist.tmp-';

/** A staging directory that carries no owner, so any build may reclaim it. */
const LEGACY_STAGE_NAME = 'dist.tmp';

/**
 * Age after which a newer build reclaims a staging tree whose owner still looks
 * alive — the fallback for a recycled pid.
 *
 * A tree lives for one package's bundler run. The slowest cache-miss `build` is
 * about 25 seconds on a fast workstation (declaration emit included); ×10 for
 * the slowest architecture and ×4 for a loaded box gives about 17 minutes, and
 * two hours is several times that. Erring long is deliberate: too short deletes
 * a running build's output, too long only leaves a directory until the next build.
 */
const ORPHAN_MAX_AGE_MS = 2 * 60 * 60 * 1000;

/** Staging directory names this module owns, e.g. `dist.tmp-4242`. */
const STAGE_NAME_RE = new RegExp(`^${STAGE_PREFIX.replace('.', '\\.')}(\\d+)$`);

/**
 * Bundle artifacts the build owns and may remove. Declarations are excluded:
 * `tsc --emitDeclarationOnly` writes them after the bundler and overwrites
 * rather than clearing, so they are outside the window this module closes.
 */
const PRUNABLE = /\.(js|cjs|mjs)(\.map)?$/;

/**
 * Declaration artifacts: never in a run's published set and overwritten rather
 * than cleared, so one whose source was deleted would otherwise ship in the
 * package tarball.
 */
const DECLARATION = /\.d\.ts(\.map)?$/;

/**
 * Whether a package-relative source path (any separator) is test-only: a
 * `*.test.ts`, a `*.test-helpers.ts`, or a file under `__test-helpers__`.
 * Builds emit none of them (`build-ts.mjs`, each `tsconfig.build.json`), so a
 * published package imports no private test-support package.
 */
export function isTestOnlySource(rel) {
  if (rel.endsWith('.test.ts') || rel.endsWith('.test-helpers.ts')) return true;
  return rel.split(/[\\/]/).includes('__test-helpers__');
}

/** Source extensions a declaration in `dist/` can have been emitted from. */
const DECLARATION_SOURCES = ['.ts', '.tsx'];

/** Every file under `dir`, as paths relative to `dir`. */
function filesUnder(dir, base = '') {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const rel = base === '' ? entry.name : path.join(base, entry.name);
    if (entry.isDirectory()) out.push(...filesUnder(path.join(dir, entry.name), rel));
    else out.push(rel);
  }
  return out;
}

/** The staging directory a given process owns, a sibling of `dist/`. */
function stagePath(pkgDir, pid) {
  return path.join(pkgDir, `${STAGE_PREFIX}${pid}`);
}

/**
 * Whether a process id is running. `process.kill(pid, 0)` sends no signal, and
 * works where `/proc` does not exist; a `/proc/<pid>` probe there would read
 * every pid as dead and reclaim a live build's staging tree.
 *
 * Fails safe: only `ESRCH` counts as dead, so `EPERM` (another user's live
 * process) keeps its tree. A non-positive id is rejected first, because
 * `process.kill(0, …)` addresses the whole process group.
 */
export function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code !== 'ESRCH';
  }
}

/**
 * Whether a staging tree is older than `maxAgeMs`, by the stage root's mtime:
 * time since the last top-level entry change, not since any write deeper in.
 * Enough here, as `ORPHAN_MAX_AGE_MS` is orders of magnitude above a whole build.
 */
function olderThan(dir, now, maxAgeMs) {
  try {
    return now - statSync(dir).mtimeMs > maxAgeMs;
  } catch {
    // The tree vanished under us — another build reclaimed it first.
    return false;
  }
}

/**
 * Discard staging trees of builds no longer running, so a crash leaks no
 * directory. A tree is reclaimed when its owner is gone, or is alive but the
 * tree is older than `ORPHAN_MAX_AGE_MS` (a recycled pid). An ownerless tree is
 * always reclaimable; nothing else in the package directory is touched.
 */
export function reclaimOrphanStages(pkgDir, opts = {}) {
  const pid = opts.pid ?? process.pid;
  const now = opts.now ?? Date.now();
  const isAlive = opts.isAlive ?? isPidAlive;
  const maxAgeMs = opts.maxAgeMs ?? ORPHAN_MAX_AGE_MS;

  let entries;
  try {
    entries = readdirSync(pkgDir, { withFileTypes: true });
  } catch {
    return [];
  }

  const reclaimed = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const full = path.join(pkgDir, entry.name);

    if (entry.name !== LEGACY_STAGE_NAME) {
      const match = STAGE_NAME_RE.exec(entry.name);
      if (!match) continue;
      const owner = Number(match[1]);
      if (owner === pid) continue;
      if (isAlive(owner) && !olderThan(full, now, maxAgeMs)) continue;
    }

    rmSync(full, { recursive: true, force: true });
    reclaimed.push(entry.name);
  }
  return reclaimed.sort();
}

/**
 * Prepare this process's empty staging directory, after reclaiming abandoned
 * ones. The pid in its name keeps concurrent builds of one package from
 * deleting each other's in-flight output.
 */
export function stageDir(pkgDir, opts = {}) {
  const pid = opts.pid ?? process.pid;
  reclaimOrphanStages(pkgDir, { ...opts, pid });
  const stage = stagePath(pkgDir, pid);
  rmSync(stage, { recursive: true, force: true });
  mkdirSync(stage, { recursive: true });
  return stage;
}

/**
 * Publish order: new destinations first, overwrites after. An updated importer
 * visible before its new dependency lands would hit ERR_MODULE_NOT_FOUND
 * between the two renames.
 *
 * Existence is sampled up front, which is exact: publishing only adds paths,
 * so a destination classified as new cannot become an overwrite.
 */
export function orderForPublish(distDir, relPaths) {
  const created = [];
  const overwritten = [];
  for (const rel of relPaths) {
    (existsSync(path.join(distDir, rel)) ? overwritten : created).push(rel);
  }
  return [...created, ...overwritten];
}

/**
 * Move every staged file into `dist/` and return the `dist/`-relative paths. A
 * failure part-way leaves the staging directory for the next `stageDir` to clear.
 */
export function publishStagedDist(pkgDir, opts = {}) {
  const stage = stagePath(pkgDir, opts.pid ?? process.pid);
  if (!existsSync(stage)) return [];
  const dist = path.join(pkgDir, 'dist');
  const published = filesUnder(stage);
  for (const rel of orderForPublish(dist, published)) {
    const dest = path.join(dist, rel);
    mkdirSync(path.join(dest, '..'), { recursive: true });
    renameSync(path.join(stage, rel), dest);
  }
  rmSync(stage, { recursive: true, force: true });
  return published.sort();
}

/**
 * Refuse a publish that moved no files. Callers run this right after a bundler
 * run that had to emit something, so an empty set means the staging tree was
 * removed mid-build; exiting zero would hand a stale `dist/` to the next deploy.
 */
export function assertPublished(pkgDir, publishedPaths, opts = {}) {
  if (publishedPaths.length > 0) return;
  const stage = stagePath(pkgDir, opts.pid ?? process.pid);
  throw new Error(
    `atomic dist publish moved no files for ${pkgDir}: expected staged output in ${stage}. ` +
      `The bundler emitted artifacts, so an empty publish means the staging tree was removed ` +
      `underneath this build. Failing rather than reporting a build that produced nothing.`,
  );
}

/**
 * Remove bundle artifacts in `dist/` that this run did not produce. Runs after
 * every rename, so no file is missing between generations.
 *
 * An empty published set prunes nothing: it means the publish found no
 * staging directory, and treating every artifact as stale would empty a `dist/`
 * that a reader is using.
 */
export function pruneStaleArtifacts(pkgDir, publishedPaths) {
  const dist = path.join(pkgDir, 'dist');
  if (publishedPaths.length === 0 || !existsSync(dist)) return [];
  const keep = new Set(publishedPaths);
  const removed = [];
  for (const rel of filesUnder(dist)) {
    if (keep.has(rel) || !PRUNABLE.test(rel)) continue;
    rmSync(path.join(dist, rel));
    removed.push(rel);
  }
  return removed.sort();
}

/**
 * Remove `dist/` declarations whose source is gone from `src/` or is test-only
 * (isTestOnlySource), so an older `dist/` cannot ship them.
 *
 * Every declaration-emitting package maps `src/<rel>.ts` to `dist/<rel>.d.ts`,
 * so the source path decides this exactly, without parsing compiler config.
 * Running before the type emitter is safe: a declaration about to be emitted
 * has a live, non-test source.
 */
export function pruneOrphanDeclarations(pkgDir) {
  const dist = path.join(pkgDir, 'dist');
  const src = path.join(pkgDir, 'src');
  if (!existsSync(dist) || !existsSync(src)) return [];

  const removed = [];
  for (const rel of filesUnder(dist)) {
    if (!DECLARATION.test(rel)) continue;
    const stem = rel.replace(DECLARATION, '');
    const live =
      !isTestOnlySource(`${stem}.ts`) &&
      DECLARATION_SOURCES.some((ext) => existsSync(path.join(src, stem + ext)));
    if (live) continue;
    rmSync(path.join(dist, rel));
    removed.push(rel);
  }
  return removed.sort();
}

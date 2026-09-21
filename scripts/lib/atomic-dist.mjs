/**
 * Atomic publish of a package's `dist/`.
 *
 * A build that clears `dist/` before writing it leaves a window in which a
 * module is genuinely absent, and any concurrent reader resolving it dies with
 * ERR_MODULE_NOT_FOUND. Readers are not all under this repo's control — the
 * trusted in-place agent that runs the deploy workflow, a second shell running
 * `pnpm build`, an editor's TypeScript server, and build-service.mjs itself
 * reading a peer's dist/index.js all resolve built artifacts while a build may
 * be running.
 *
 * So the writer never clears. The build stages its output in a directory named
 * after its own process, `<pkg>/dist.tmp-<pid>`, so two builds of one package
 * never share a staging tree;
 * each artifact is moved onto its destination with a single rename(2) — atomic
 * within one filesystem, and staging is a sibling of `dist/` so it always is —
 * and only afterwards are artifacts this run did not produce removed.
 *
 * The guarantee is per path, not per generation: every path the run still
 * produces stays continuously readable — a reader gets the old bytes or the new
 * ones, never an absent file — a path the run newly produces exists before any
 * updated file that could import it becomes visible, and a path the run stopped
 * producing is removed only after every replacement is already in place. A
 * reader that resolved a previous-generation module can therefore still miss a
 * content-hashed chunk that generation imported (rolldown emits
 * `rolldown-runtime-<hash>.js`) if the hash moved, a window of the few
 * milliseconds between publish and prune rather than the whole bundler run.
 */
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';

/** Prefix of the per-process staging directory, a sibling of `dist/`. */
const STAGE_PREFIX = 'dist.tmp-';

/** A staging directory that carries no owner, so any build may reclaim it. */
const LEGACY_STAGE_NAME = 'dist.tmp';

/**
 * How long a staging directory may sit before a newer build reclaims it from an
 * owner that still looks alive.
 *
 * A staging tree lives for exactly one package's bundler run. The slowest
 * cache-miss `build` task any of these scripts drives is about 25 seconds on the
 * development machine, and that figure also covers the declaration emit that
 * runs after the staging window closes. Ten times that for the slowest
 * architecture that builds this repo, four times again for a loaded box, is
 * about 17 minutes; two hours is several times that bound.
 *
 * The gate is a fallback behind the liveness probe, reached only when a pid has
 * been recycled — a live owner is spared until the tree is this old. Erring long
 * is deliberate: a threshold that is too short deletes a running build's output,
 * while one that is too long only leaves a directory on disk until the next
 * build of that package.
 */
const ORPHAN_MAX_AGE_MS = 2 * 60 * 60 * 1000;

/** Staging directory names this module owns, e.g. `dist.tmp-4242`. */
const STAGE_NAME_RE = new RegExp(`^${STAGE_PREFIX.replace('.', '\\.')}(\\d+)$`);

/**
 * Bundle artifacts the build owns and may therefore remove. Declaration files
 * are excluded: `tsc --emitDeclarationOnly` writes them after the bundler
 * runs, and it overwrites rather than clearing, so they are never part of the
 * window this module closes.
 */
const PRUNABLE = /\.(js|cjs|mjs)(\.map)?$/;

/**
 * Declaration artifacts, which the type emitter writes after the bundler has
 * already published and is therefore never part of a run's published set. They
 * are overwritten rather than cleared, so an entry whose source was deleted
 * would otherwise stay in `dist/` and ship in the package tarball.
 */
const DECLARATION = /\.d\.ts(\.map)?$/;

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
 * Whether a process id is currently running.
 *
 * `process.kill(pid, 0)` sends no signal; it only asks the kernel whether the
 * target exists. It is used rather than a `/proc/<pid>` probe because these
 * build scripts run wherever a package is compiled, including machines with no
 * `/proc` — there, every pid would read as dead and a live concurrent build's
 * staging tree would be reclaimed.
 *
 * Fails safe: only `ESRCH` (no such process) counts as dead, so `EPERM` — a live
 * process owned by someone else — keeps its tree. A non-positive id is rejected
 * before the call, because `process.kill(0, …)` addresses the whole process
 * group.
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
 * Whether a staging tree is older than `maxAgeMs`.
 *
 * The clock is the stage root's own mtime, and a directory bumps that only when
 * an entry is created or removed directly inside it — a write deeper in the
 * tree does not refresh it. So this measures time since the bundler last added
 * a top-level artifact, not time since any activity. That is enough for what
 * the gate does: `ORPHAN_MAX_AGE_MS` is set orders of magnitude above a whole
 * build, so the distinction cannot decide the outcome for a running one.
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
 * Discard staging trees left behind by builds that are no longer running, so a
 * per-process staging name does not leak a directory on every crash.
 *
 * A tree is reclaimed when its owner is gone, or when its owner id is in use but
 * the tree is older than `ORPHAN_MAX_AGE_MS` — the second arm covers a recycled
 * process id, which liveness alone cannot tell apart from a build still in
 * flight. A tree whose name carries no owner is always reclaimable. Anything
 * else in the package directory is left untouched.
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
 * Prepare this process's staging directory for a build to write into.
 *
 * The name carries the process id, so two builds of one package in one working
 * tree write into separate trees and cannot delete each other's in-flight
 * output. Trees abandoned by builds that are no longer running are reclaimed
 * first, which is what a fixed name used to give for free.
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
 * Publish order: destinations that do not exist in `dist/` yet come first, the
 * overwrites after. A run that adds a module also rewrites the importer that
 * reaches it, so swapping the importer in before its new dependency landed
 * would reintroduce exactly the ERR_MODULE_NOT_FOUND this module closes — for
 * the milliseconds between the two renames rather than the whole bundler run.
 * Publishing every new path first means that by the time any updated file is
 * visible, everything it can import is already on disk.
 *
 * Existence is sampled up front, which is exact: publishing only ever adds
 * paths, so a destination classified as new cannot become an overwrite.
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
 * Move every staged file onto its `dist/` destination and return the published
 * paths, relative to `dist/`. A failure part-way through leaves the staging
 * directory in place; the next `stageDir` clears it.
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
 * Refuse to treat a publish that moved no files as a successful build.
 *
 * Both build scripts call this straight after a bundler run that had to emit at
 * least one artifact, so an empty published set never means "this run
 * legitimately produced nothing" — it means the staging tree was removed while
 * the build was writing into it. Reporting a file count and exiting zero there
 * hands a stale `dist/` to whatever deploys next.
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
 * Remove bundle artifacts left over from an earlier build — those present in
 * `dist/` but absent from this run's output. Runs after every rename, so no
 * file is ever missing between the two generations.
 *
 * An empty published set prunes nothing. Both callers reach here straight after
 * a bundler run that had to emit at least one entry, so an empty set does not
 * mean "this run legitimately produced no artifacts" — it means the publish
 * found no staging directory, which is the one case where treating every
 * existing artifact as stale would empty a `dist/` that a reader is using.
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
 * Remove declaration files in `dist/` whose source no longer exists in `src/`.
 *
 * Every package that emits declarations maps `src/<rel>.ts` to
 * `dist/<rel>.d.ts`, so source existence decides this exactly, with no
 * compiler-config parsing: one package excludes tests from its program and
 * another does not, and both are handled by the same rule. A declaration the
 * current run is about to emit has a source by definition, so this can never
 * delete a live one even though it runs before the type emitter.
 */
export function pruneOrphanDeclarations(pkgDir) {
  const dist = path.join(pkgDir, 'dist');
  const src = path.join(pkgDir, 'src');
  if (!existsSync(dist) || !existsSync(src)) return [];

  const removed = [];
  for (const rel of filesUnder(dist)) {
    if (!DECLARATION.test(rel)) continue;
    const stem = rel.replace(DECLARATION, '');
    if (DECLARATION_SOURCES.some((ext) => existsSync(path.join(src, stem + ext)))) continue;
    rmSync(path.join(dist, rel));
    removed.push(rel);
  }
  return removed.sort();
}

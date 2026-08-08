/**
 * Lock-load shape + compatibility validation.
 *
 * A fetched lock must be a valid JSON document whose schemaVersion falls within
 * this orchestrator's compatibility window (at or above BREAKING_FLOOR, and
 * requiring a reader no newer than SCHEMA_VERSION), and whose routing matchers
 * are well-formed LabelMatcher objects. A lock compiled by an older engine
 * stored `runsOn` as a plain string array; without the floor gate those strings
 * would parse past the dispatch path as an empty label set and mis-route jobs to
 * an arbitrary scaler. These checks run at the cache choke point and surface as
 * a `LockFileParseError` (the established corrupt-lock signal).
 */

import {
  LabelMatcher,
  LockFileParseError,
  SCHEMA_VERSION,
  BREAKING_FLOOR,
  isLockStaticJob,
  type LockFile,
} from '@kici-dev/engine';

/** Parse the raw lock JSON and assert the minimal document shape. */
export function parseLockDocument(raw: string, repoIdentifier: string, ref: string): LockFile {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new LockFileParseError(
      repoIdentifier,
      ref,
      `Lock file at ${repoIdentifier} ref=${ref} is not valid JSON: ${(err as Error).message}`,
    );
  }
  const schemaVersion = (parsed as { schemaVersion?: unknown } | null)?.schemaVersion;
  if (typeof parsed !== 'object' || parsed === null || typeof schemaVersion !== 'number') {
    throw new LockFileParseError(
      repoIdentifier,
      ref,
      `Invalid lock file at ${repoIdentifier} ref=${ref}: missing or invalid schemaVersion`,
    );
  }
  return parsed as LockFile;
}

/**
 * Enforce the two-sided lock-schema compatibility window. Accept any lock whose
 * `schemaVersion` is at or above this codebase's `BREAKING_FLOOR` and whose
 * required reader version is at or below this orchestrator's `SCHEMA_VERSION`.
 * Both out-of-window cases throw a `LockFileParseError` (the established
 * corrupt-lock signal) carrying operator-actionable guidance.
 */
export function assertLockFileSchemaCompatible(
  lockFile: LockFile,
  repoIdentifier: string,
  ref: string,
): void {
  // Too old: the lock predates a breaking change this codebase relies on. An
  // older SDK emitted a shape (e.g. pre-v20 string-array runsOn) that this
  // reader would mis-parse — reject rather than mis-route.
  if (lockFile.schemaVersion < BREAKING_FLOOR) {
    throw new LockFileParseError(
      repoIdentifier,
      ref,
      `Lock file schema v${lockFile.schemaVersion} predates the oldest supported version ` +
        `v${BREAKING_FLOOR} — recompile with a current SDK (\`kici compile\`) and push again.`,
    );
  }
  // Too new (breaking): the lock requires a reader newer than this orchestrator.
  // Pre-window locks omit minReaderVersion; fall back to schemaVersion so a
  // newer lock without the field keeps exact-match strictness (safe default).
  const minReader = lockFile.minReaderVersion ?? lockFile.schemaVersion;
  if (SCHEMA_VERSION < minReader) {
    throw new LockFileParseError(
      repoIdentifier,
      ref,
      `Lock file requires orchestrator schema >= v${minReader} but this orchestrator ` +
        `understands <= v${SCHEMA_VERSION} — upgrade the orchestrator to a newer version.`,
    );
  }
}

function assertElementsAreMatchers(elements: readonly unknown[], ctx: string): void {
  for (const el of elements) {
    if (!LabelMatcher.safeParse(el).success) {
      throw new Error(
        `${ctx}: invalid label matcher ${JSON.stringify(el)} — expected ` +
          `{ kind: 'exact', value } or { kind: 'regex', source, flags }. The lock file is likely ` +
          `stale or compiled by an older engine — recompile with \`kici compile\`.`,
      );
    }
  }
}

/**
 * Walk every static job's runsOn / excludeLabels / runsOnAll matchers and throw
 * if any element is not a valid LabelMatcher. Dynamic job generators carry no
 * static routing matchers, so only static jobs are checked (mirrors
 * assertLockFileRegexesSafe).
 */
export function assertLockFileMatchersValid(lockFile: LockFile): void {
  for (const wf of lockFile.workflows ?? []) {
    for (const job of wf.jobs ?? []) {
      if (!isLockStaticJob(job)) continue;
      const ctx = `lock workflow '${wf.name}' job '${job.name}'`;
      if (job.runsOn) assertElementsAreMatchers(job.runsOn as readonly unknown[], `${ctx} runsOn`);
      if (job.excludeLabels) {
        assertElementsAreMatchers(job.excludeLabels as readonly unknown[], `${ctx} excludeLabels`);
      }
      if (job.runsOnAll) {
        for (const grp of job.runsOnAll.include ?? []) {
          assertElementsAreMatchers(grp as readonly unknown[], `${ctx} runsOnAll include`);
        }
        if (job.runsOnAll.exclude) {
          assertElementsAreMatchers(
            job.runsOnAll.exclude as readonly unknown[],
            `${ctx} runsOnAll exclude`,
          );
        }
      }
    }
  }
}

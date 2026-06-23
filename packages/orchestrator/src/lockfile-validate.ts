/**
 * Lock-load shape + compatibility validation.
 *
 * A fetched lock must be a valid JSON document whose schemaVersion matches this
 * orchestrator's engine SCHEMA_VERSION exactly, and whose routing matchers are
 * well-formed LabelMatcher objects. A lock compiled by an older engine stored
 * `runsOn` as a plain string array; without this gate those strings would parse
 * past the dispatch path as an empty label set and mis-route jobs to an
 * arbitrary scaler. These checks run at the cache choke point and surface as a
 * `LockFileParseError` (the established corrupt-lock signal).
 */

import {
  LabelMatcher,
  LockFileParseError,
  SCHEMA_VERSION,
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

/** Reject a lock whose schemaVersion does not exactly match this orchestrator. */
export function assertLockFileSchemaCompatible(lockFile: LockFile): void {
  if (lockFile.schemaVersion !== SCHEMA_VERSION) {
    throw new Error(
      `Lock file schemaVersion ${lockFile.schemaVersion} is incompatible with this orchestrator ` +
        `(engine SCHEMA_VERSION ${SCHEMA_VERSION}). Recompile the lock with \`kici compile\` and push again.`,
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

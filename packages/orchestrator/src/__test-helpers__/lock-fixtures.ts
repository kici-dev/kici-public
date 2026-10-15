/**
 * Lock-file builders the orchestrator tests share. Every call returns fresh
 * objects, so a test may mutate what it gets.
 *
 * The literals are partial on purpose: they carry the fields the orchestrator
 * reads and omit the rest (`minReaderVersion`, a workflow's `contentHash`), the
 * same as the inline literals they replace.
 */
import type { LockFile, LockJob, LockWorkflow } from '@kici-dev/engine';

/**
 * Overrides keyed by the lock type's own field names. The values are not
 * type-checked, because many tests pass fields from older lock shapes (a step
 * `run`, a numeric `schemaVersion` other than the current one).
 */
type Overrides<T> = { [K in keyof T]?: unknown };

/** A static `build` job with one `Build` step, runnable on `linux`. */
export function staticJob(overrides: Overrides<LockJob> = {}): LockJob {
  return {
    _type: 'static',
    name: 'build',
    runsOn: [{ kind: 'exact', value: 'linux' }],
    needs: [],
    steps: [{ name: 'Build', hasOutputs: false }],
    ...overrides,
  } as LockJob;
}

/** A `CI` workflow triggered by pull-request open and synchronize, with one {@link staticJob}. */
export function lockWorkflow(overrides: Overrides<LockWorkflow> = {}): LockWorkflow {
  return {
    name: 'CI',
    triggers: [
      {
        _type: 'pr',
        events: ['opened', 'synchronize'],
        targetBranches: [],
        sourceBranches: [],
        paths: [],
      },
    ],
    jobs: [staticJob()],
    ...overrides,
  } as LockWorkflow;
}

/** A schema-1 lock file for `.kici/workflows/ci.ts` holding one {@link lockWorkflow}. */
export function lockFileFixture(overrides: Overrides<LockFile> = {}): LockFile {
  return {
    schemaVersion: 1,
    source: { file: '.kici/workflows/ci.ts', export: '#default' },
    contentHash: 'test-hash',
    workflows: [lockWorkflow()],
    ...overrides,
  } as LockFile;
}

/**
 * The runtime facts a job's own shape demands of the host that runs it, which
 * live in `dispatch-matched-workflow.ts` beside the selector partitioning they
 * feed. A file of their own because that suite carries heavy dispatch
 * scaffolding and this is a pure function over a lock job's `container`.
 */
import { describe, it, expect } from 'vitest';
import { CONTAINER_BUILD_RUNTIME_LABEL } from '@kici-dev/engine';
import {
  requiredRuntimeLabelsFor,
  runsOnSelectorsForLockJob,
} from './dispatch-matched-workflow.js';

describe('requiredRuntimeLabelsFor', () => {
  it('requires a build-capable host for a dockerfile job', () => {
    expect(requiredRuntimeLabelsFor({ dockerfile: '.kici/ci.Dockerfile' })).toEqual([
      CONTAINER_BUILD_RUNTIME_LABEL,
    ]);
  });

  it('adds NOTHING for a job that names a finalized image', () => {
    // Adding an implicit requirement to jobs that already work is how container
    // jobs were stranded once before — they had been running fine, and a gate
    // the orchestrator could not evaluate made them match nothing.
    expect(requiredRuntimeLabelsFor('python:3.12')).toEqual([]);
    expect(requiredRuntimeLabelsFor({ image: 'python:3.12' })).toEqual([]);
  });

  it('adds nothing for a job with no container at all', () => {
    expect(requiredRuntimeLabelsFor(undefined)).toEqual([]);
  });
});

describe('runsOnSelectorsForLockJob', () => {
  it('carries the authored labels through UNCHANGED, even for a dockerfile job', () => {
    // The requirement is applied when matching registered agents, not here:
    // these selectors are also what the scaler consult sees, and a backend is
    // chosen by exact label-set containment. A label no pool declares would
    // strand the job `queued-no-backend` rather than spawn anything.
    const sel = runsOnSelectorsForLockJob({
      runsOn: [{ kind: 'exact', value: 'linux' }],
    });
    expect(sel.runsOnLabels).toEqual(['linux']);
  });

  it('keeps regex patterns and exclusions partitioned as before', () => {
    const sel = runsOnSelectorsForLockJob({
      runsOn: [{ kind: 'regex', source: '^gpu-', flags: '' }],
      excludeLabels: [{ kind: 'exact', value: 'spot' }],
    });
    expect(sel.runsOnPatterns).toHaveLength(1);
    expect(sel.excludeLabels).toEqual(['spot']);
    expect(sel.runsOnLabels).toEqual([]);
  });
});

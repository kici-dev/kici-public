/**
 * The runtime facts a job's shape demands of its host (in
 * `dispatch-matched-workflow.ts`): a pure function over a lock job's `container`,
 * tested apart from that suite's heavy dispatch scaffolding.
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
    // An implicit requirement on working jobs once stranded container jobs: a gate
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
    // Applied when matching registered agents, not here: the scaler consult sees
    // these selectors and picks a backend by exact label-set containment, so a label
    // no pool declares would strand the job `queued-no-backend`.
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

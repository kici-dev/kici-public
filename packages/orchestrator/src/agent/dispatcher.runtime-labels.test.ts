/**
 * The extra label a dockerfile job needs from a registered agent.
 *
 * Its whole point is WHERE it applies: the registry match, never the scaler
 * consult. A scaler backend is chosen by exact label-set containment, so a
 * requirement no pool declares would strand the job instead of spawning for it.
 */
import { describe, it, expect } from 'vitest';
import { CONTAINER_BUILD_RUNTIME_LABEL } from '@kici-dev/engine';
import { containerSpawnFor } from './dispatcher.js';
import { requiredRuntimeLabelsFor } from '../pipeline/dispatch-matched-workflow.js';

describe('dockerfile job routing', () => {
  const dockerfileJob = { container: { dockerfile: '.kici/ci.Dockerfile' } };

  it('requires a build-capable host for a dockerfile job', () => {
    expect(requiredRuntimeLabelsFor(dockerfileJob.container)).toEqual([
      CONTAINER_BUILD_RUNTIME_LABEL,
    ]);
  });

  it('requires nothing extra of a job that names a finalized image', () => {
    expect(requiredRuntimeLabelsFor({ image: 'python:3.12' })).toEqual([]);
    expect(requiredRuntimeLabelsFor('python:3.12')).toEqual([]);
    expect(requiredRuntimeLabelsFor(undefined)).toEqual([]);
  });

  it('still offers the scaler no per-job-image spawn for a dockerfile job', () => {
    // The two halves have to agree: the scaler stands down (no image exists
    // yet) AND is not handed a label its pools do not declare.
    expect(containerSpawnFor(dockerfileJob)).toBeUndefined();
  });
});

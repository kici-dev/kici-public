/**
 * The dockerfile-build trust gate, which lives in `dispatch-matched-workflow.ts`
 * beside the sandbox-grant gate it mirrors.
 *
 * A file of its own rather than a block inside
 * `dispatch-matched-workflow.test.ts`: that suite carries heavy dispatch
 * scaffolding, and this gate is a pure function over a workflow, a ref scope and
 * a boolean. Named after its subject so the pairing is not a guess.
 */
import { describe, it, expect } from 'vitest';
import { CacheRefScope } from '@kici-dev/engine';
import type { LockWorkflow } from '@kici-dev/engine';
import { resolveWorkflowDockerfileBuilds } from './dispatch-matched-workflow.js';

/** A one-job workflow whose single static job carries `container`. */
function workflowWith(container: unknown): LockWorkflow {
  return {
    name: 'wf',
    triggers: [],
    jobs: [
      {
        _type: 'static',
        name: 'build',
        steps: [],
        needs: [],
        ...(container !== undefined ? { container } : {}),
      },
    ],
  } as unknown as LockWorkflow;
}

describe('resolveWorkflowDockerfileBuilds', () => {
  const dockerfileWf = workflowWith({ dockerfile: '.kici/ci.Dockerfile' });

  it('allows a trusted ref regardless of the org setting', () => {
    expect(
      resolveWorkflowDockerfileBuilds(dockerfileWf, {
        scope: CacheRefScope.enum.shared,
        allowUntrusted: false,
      }),
    ).toEqual({ allowed: true });
  });

  it('refuses an untrusted ref when the org has not opted in', () => {
    // Loud and total: a Dockerfile build runs outside the job sandbox, so an
    // untrusted ref must not reach it by default.
    const res = resolveWorkflowDockerfileBuilds(dockerfileWf, {
      scope: CacheRefScope.enum.isolated,
      allowUntrusted: false,
    });
    expect(res).toHaveProperty('denied');
    const reason = (res as { denied: { reason: string } }).denied.reason;
    // The reason has to name the job, the file and the knob: an author reading
    // it in the dashboard has no other context.
    expect(reason).toMatch(/job 'build'/);
    expect(reason).toMatch(/\.kici\/ci\.Dockerfile/);
    expect(reason).toMatch(/allow-untrusted-dockerfile-builds/);
    // ...and it has to name every way a ref gets here. An internally-triggered
    // run (a `kiciEvent()` subscriber that inherited a non-trusted tier, or
    // inherited nothing at all) reaches this gate too, and telling its author it
    // is "a fork PR, or a contributor whose trust could not be resolved" is
    // simply false. "without a trusted emitter" is the wording that covers the
    // inherited-untrusted case AND the inherited-nothing fallback.
    expect(reason).toMatch(/internally-triggered run without a trusted emitter/);
  });

  it('allows an untrusted ref once the operator opts in', () => {
    expect(
      resolveWorkflowDockerfileBuilds(dockerfileWf, {
        scope: CacheRefScope.enum.isolated,
        allowUntrusted: true,
      }),
    ).toEqual({ allowed: true });
  });

  it('ignores a job that names a finalized image', () => {
    for (const container of ['python:3.12', { image: 'python:3.12' }]) {
      expect(
        resolveWorkflowDockerfileBuilds(workflowWith(container), {
          scope: CacheRefScope.enum.isolated,
          allowUntrusted: false,
        }),
      ).toEqual({ allowed: true });
    }
  });

  it('ignores a job with no container at all', () => {
    expect(
      resolveWorkflowDockerfileBuilds(workflowWith(undefined), {
        scope: CacheRefScope.enum.isolated,
        allowUntrusted: false,
      }),
    ).toEqual({ allowed: true });
  });

  it('refuses on the first dockerfile job, whichever it is', () => {
    const wf = {
      name: 'wf',
      triggers: [],
      jobs: [
        { _type: 'static', name: 'a', steps: [], needs: [], container: 'python:3.12' },
        { _type: 'static', name: 'b', steps: [], needs: [], container: { dockerfile: 'D' } },
      ],
    } as unknown as LockWorkflow;

    const res = resolveWorkflowDockerfileBuilds(wf, {
      scope: CacheRefScope.enum.isolated,
      allowUntrusted: false,
    });
    expect((res as { denied: { reason: string } }).denied.reason).toMatch(/job 'b'/);
  });
});

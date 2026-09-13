/**
 * Tests for the canonical build context sent with a job dispatch.
 *
 * The context is what lets the orchestrator cross-check a deferred
 * attestation against its own run row. If it does not reach the agent, the
 * agent freezes its local guess instead — `repository: 'unknown/unknown'` for a
 * `file://` clone, and a bare workflow name where the claim is `<name>@<sha>` —
 * and the capture check then refuses every deferred attestation that
 * orchestrator produces.
 */
import { describe, expect, it } from 'vitest';
import { createMockDb } from '../__test-helpers__/mock-db.js';
import { loadProvenanceContext } from './dispatch-context.js';

const RUN = {
  run_id: 'run-1',
  routing_key: null,
  repo_identifier: 'acme/app',
  ref: 'main',
  sha: 'deadbeef',
  workflow_name: 'release',
  provider: 'github',
  local_working_tree: false,
};

function dbWithRun(run: unknown) {
  const { db, mocks } = createMockDb({});
  mocks.selectExecuteTakeFirst.mockResolvedValueOnce(run);
  return db;
}

describe('loadProvenanceContext', () => {
  it('derives workflowRef as the token claim, not the clone ref', async () => {
    const ctx = await loadProvenanceContext(dbWithRun(RUN) as never, 'run-1', 'job-1', {
      issuer: 'https://orch.example',
      orchestratorId: 'orch-1',
    });
    // `<workflow_name>@<sha>` — exactly what `buildIdTokenClaims` emits, and
    // what `crossCheckBuildContext` compares the statement's `workflow.path`
    // against. A global workflow's clone ref would never equal this.
    expect(ctx!.workflowRef).toBe('release@deadbeef');
    expect(ctx!.repository).toBe('acme/app');
    expect(ctx!.ref).toBe('main');
    expect(ctx!.runId).toBe('run-1');
    expect(ctx!.jobId).toBe('job-1');
  });

  it('still sends the context when no provenance issuer is configured', async () => {
    // The regression this test exists for: gating on the issuer dropped the
    // context for every orchestrator on the deprecated Platform-relay mint, so
    // its agent fell back to the local guess and the capture check refused all
    // of its deferred attestations. The cross-check reads none of the fields
    // an issuer affects.
    const ctx = await loadProvenanceContext(dbWithRun(RUN) as never, 'run-1', 'job-1', {
      issuer: undefined,
      orchestratorId: 'orch-1',
    });
    expect(ctx, 'the context must be sent regardless of who signs the token').toBeDefined();
    expect(ctx!.repository).toBe('acme/app');
    expect(ctx!.workflowRef).toBe('release@deadbeef');
    // Only `builder.id` needs an issuer; an empty one reproduces the
    // `/orchestrator/unknown` builder the local guess always recorded.
    expect(ctx!.issuer).toBe('');
  });

  it('omits the workflow ref sha segment when the run has none', async () => {
    const ctx = await loadProvenanceContext(
      dbWithRun({ ...RUN, sha: null }) as never,
      'run-1',
      'job-1',
      { issuer: 'https://orch.example', orchestratorId: 'orch-1' },
    );
    expect(ctx!.workflowRef).toBe('release');
  });

  it('returns undefined only when the run row is absent', async () => {
    expect(
      await loadProvenanceContext(dbWithRun(undefined) as never, 'missing', 'job-1', {
        issuer: 'https://orch.example',
        orchestratorId: 'orch-1',
      }),
    ).toBeUndefined();
  });

  it('brands a local-working-tree run as run-remote', async () => {
    const ctx = await loadProvenanceContext(
      dbWithRun({ ...RUN, local_working_tree: true }) as never,
      'run-1',
      'job-1',
      { issuer: 'https://orch.example', orchestratorId: 'orch-1' },
    );
    expect(ctx!.sourceOrigin).toBe('run-remote');
  });
});

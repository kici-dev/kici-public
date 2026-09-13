/**
 * Tests for the capture-time cross-check.
 *
 * The property under test: the orchestrator refuses to store a frozen statement
 * that disagrees with its own run row, so the retrier never mints a token
 * committing to one. Each rejection case carries a positive control — the same
 * capture with the field corrected is ACCEPTED — so a test cannot pass because
 * the check refuses everything.
 */
import { describe, expect, it } from 'vitest';
import {
  IN_TOTO_STATEMENT_TYPE,
  KICI_WORKFLOW_BUILD_TYPE,
  SLSA_PROVENANCE_PREDICATE_TYPE,
} from '@kici-dev/engine/provenance/schema';
import { createMockDb } from '../__test-helpers__/mock-db.js';
import { DeferredAttestationRejectReason } from '../metrics/prometheus.js';
import { checkDeferredCapture } from './verify-deferred-capture.js';

const RUN = {
  run_id: 'run-1',
  routing_key: null,
  repo_identifier: 'acme/app',
  ref: 'main',
  sha: 'deadbeef',
  workflow_name: 'release',
  provider: 'github',
  local_working_tree: false,
  trigger_event: 'push',
  head_ref: null,
  head_repository: null,
  is_fork: false,
  trust_tier: 'trusted',
  trigger_actor_username: 'maintainer',
};

const JOB = { run_id: 'run-1', job_id: 'job-1', status: 'running' };

const SUBJECT_DIGEST = 'a'.repeat(64);

/** A statement that agrees with RUN on every field the cross-check reads. */
function honestStatement(
  overrides: {
    repository?: string;
    ref?: string;
    path?: string;
    commit?: string;
    runId?: string;
    jobId?: string;
    digest?: string;
  } = {},
) {
  return {
    _type: IN_TOTO_STATEMENT_TYPE,
    subject: [{ name: 'pkg', digest: { sha256: overrides.digest ?? SUBJECT_DIGEST } }],
    predicateType: SLSA_PROVENANCE_PREDICATE_TYPE,
    predicate: {
      buildDefinition: {
        buildType: KICI_WORKFLOW_BUILD_TYPE,
        externalParameters: {
          workflow: {
            repository: overrides.repository ?? RUN.repo_identifier,
            ref: overrides.ref ?? RUN.ref,
            // The token's `workflow_ref` claim: `<workflow_name>@<sha>`.
            path: overrides.path ?? `${RUN.workflow_name}@${RUN.sha}`,
          },
        },
        internalParameters: {
          commit: overrides.commit ?? RUN.sha,
          runId: overrides.runId ?? RUN.run_id,
          jobId: overrides.jobId ?? JOB.job_id,
          attestationOrigin: 'deferred',
        },
      },
      runDetails: {
        builder: { id: 'https://orch.example/orchestrator/orch-1' },
      },
    },
  };
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes as BufferSource);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/** Build a capture record + a mock db that answers the run and job lookups. */
async function capture(
  statement: unknown,
  opts: { statementHash?: string; subjectDigest?: string; run?: unknown; job?: unknown } = {},
) {
  const bytes = new TextEncoder().encode(JSON.stringify(statement));
  const { db, mocks } = createMockDb({});
  mocks.selectExecuteTakeFirst
    .mockResolvedValueOnce(opts.run === undefined ? RUN : opts.run)
    .mockResolvedValueOnce(opts.job === undefined ? JOB : opts.job);
  return checkDeferredCapture({
    db: db as never,
    orchestratorId: 'orch-1',
    record: {
      runId: RUN.run_id,
      jobId: JOB.job_id,
      subjectDigest: opts.subjectDigest ?? SUBJECT_DIGEST,
      statementHash: opts.statementHash ?? (await sha256Hex(bytes)),
      dsseEnvelope: { payload: Buffer.from(bytes).toString('base64') },
    },
  });
}

describe('checkDeferredCapture', () => {
  it('accepts a statement that agrees with the run row', async () => {
    const verdict = await capture(honestStatement());
    expect(verdict.ok).toBe(true);
  });

  it('returns the RECOMPUTED hash, never the reported one', async () => {
    const statement = honestStatement();
    const expected = await sha256Hex(new TextEncoder().encode(JSON.stringify(statement)));
    const verdict = await capture(statement);
    expect(verdict).toEqual({ ok: true, statementHash: expected });
  });

  it('refuses a forged statementHash rather than storing it', async () => {
    // The retrier stamps the stored hash into a server-signed claim, so an
    // agent-chosen value would have the token commit to a statement the
    // orchestrator never read.
    const verdict = await capture(honestStatement(), { statementHash: 'f'.repeat(64) });
    expect(verdict.ok).toBe(false);
    expect((verdict as { reason: string }).reason).toBe(
      DeferredAttestationRejectReason.StatementHashMismatch,
    );
  });

  it.each([
    ['repository', { repository: 'attacker/app' }],
    ['ref', { ref: 'refs/pull/7/head' }],
    ['sha', { commit: 'f'.repeat(40) }],
    ['workflow_ref', { path: 'release@f00' }],
    ['runId', { runId: 'run-other' }],
    ['jobId', { jobId: 'job-other' }],
  ])('refuses a statement whose %s contradicts the run row', async (field, overrides) => {
    const verdict = await capture(honestStatement(overrides));
    expect(verdict.ok, field).toBe(false);
    const rejection = verdict as { reason: string; detail: string };
    expect(rejection.reason).toBe(DeferredAttestationRejectReason.BuildContextMismatch);
    // The warn log has to name the field, or an operator cannot act on it.
    expect(rejection.detail).toContain(field === 'sha' ? 'sha' : field);
  });

  it('refuses a subject digest that appears in no subject', async () => {
    const verdict = await capture(honestStatement(), { subjectDigest: 'b'.repeat(64) });
    expect(verdict.ok).toBe(false);
    expect((verdict as { reason: string }).reason).toBe(
      DeferredAttestationRejectReason.SubjectDigestMismatch,
    );
  });

  it('refuses an undecodable or non-conforming payload', async () => {
    const bad = await checkDeferredCapture({
      db: createMockDb({}).db as never,
      orchestratorId: 'orch-1',
      record: {
        runId: RUN.run_id,
        jobId: JOB.job_id,
        subjectDigest: SUBJECT_DIGEST,
        statementHash: 'x',
        dsseEnvelope: { payload: 42 },
      },
    });
    expect(bad.ok).toBe(false);
    expect((bad as { reason: string }).reason).toBe(DeferredAttestationRejectReason.Unparseable);

    const notAStatement = await capture({ hello: 'world' });
    expect(notAStatement.ok).toBe(false);
    expect((notAStatement as { reason: string }).reason).toBe(
      DeferredAttestationRejectReason.Unparseable,
    );
  });

  it('refuses a capture naming a run or job that does not exist', async () => {
    expect(((await capture(honestStatement(), { run: null })) as { reason: string }).reason).toBe(
      DeferredAttestationRejectReason.RunNotFound,
    );
    expect(((await capture(honestStatement(), { job: null })) as { reason: string }).reason).toBe(
      DeferredAttestationRejectReason.RunNotFound,
    );
  });

  it('refuses the legacy agent-local statement shape', async () => {
    // What an agent that never received a `provenanceContext` freezes: the
    // job's CHECKOUT ref (a PR's HEAD branch) and a global workflow's CLONE
    // ref, neither of which is what the mint claims.
    const legacy = await capture(honestStatement({ ref: 'patch-1', path: '' }));
    expect(legacy.ok).toBe(false);
    expect((legacy as { reason: string }).reason).toBe(
      DeferredAttestationRejectReason.BuildContextMismatch,
    );

    // Positive control: the same capture built from the orchestrator's context
    // is accepted, so the refusal above is the legacy SHAPE and not the check
    // rejecting everything.
    expect((await capture(honestStatement())).ok).toBe(true);
  });
});

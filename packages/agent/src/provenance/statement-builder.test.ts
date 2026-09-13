import { describe, expect, it } from 'vitest';
import { kiciProvenanceStatementSchema } from '@kici-dev/engine/provenance/schema';
import { crossCheckBuildContext } from '@kici-dev/engine/provenance/verify';
import { buildLocalProvenanceStatement, buildProvenanceStatement } from './statement-builder.js';

const claims = {
  iss: 'https://thinker1.dev.kici.dev/kici-stg',
  repository: 'github.com/acme/api',
  ref: 'refs/tags/v0.4.2',
  sha: 'deadbeef',
  workflow_ref: '.kici/workflows/release.ts@deadbeef',
  kici_run_id: 'run-1',
  kici_job_id: 'job-1',
  orchestrator_id: 'orch-9',
};

describe('buildProvenanceStatement', () => {
  it('builds a statement that validates against the P1.1 schema', () => {
    const stmt = buildProvenanceStatement({
      tokenClaims: claims,
      subject: { name: 'pkg:npm/@acme/api@1.2.3', digest: { sha256: 'a'.repeat(64) } },
      builderVersions: { 'kici-agent': '0.7.1', 'kici-orchestrator': '0.7.1' },
      startedOn: '2026-06-11T00:00:00.000Z',
      finishedOn: '2026-06-11T00:01:00.000Z',
    });
    expect(() => kiciProvenanceStatementSchema.parse(stmt)).not.toThrow();
    expect(stmt.subject[0].digest.sha256).toBe('a'.repeat(64));
    expect(stmt.predicate.buildDefinition.externalParameters.workflow.repository).toBe(
      'github.com/acme/api',
    );
    expect(stmt.predicate.buildDefinition.internalParameters?.commit).toBe('deadbeef');
    expect(stmt.predicate.buildDefinition.internalParameters?.runId).toBe('run-1');
    expect(stmt.predicate.runDetails.builder.id).toBe(
      'https://thinker1.dev.kici.dev/kici-stg/orchestrator/orch-9',
    );
    expect(stmt.predicate.runDetails.metadata?.invocationId).toBe('run-1');
  });

  it('tolerates null identity claims (defaults to empty workflow coordinates)', () => {
    const stmt = buildProvenanceStatement({
      tokenClaims: {
        iss: 'https://issuer',
        repository: null,
        ref: null,
        sha: null,
        workflow_ref: null,
        kici_run_id: 'run-2',
        kici_job_id: 'job-2',
        orchestrator_id: null,
      },
      subject: { name: 'artifact.txt', digest: { sha256: 'b'.repeat(64) } },
      builderVersions: { 'kici-agent': '0.7.1', 'kici-orchestrator': '0.7.1' },
      startedOn: '2026-06-11T00:00:00.000Z',
      finishedOn: '2026-06-11T00:00:00.000Z',
    });
    expect(() => kiciProvenanceStatementSchema.parse(stmt)).not.toThrow();
    // Coerces to the exact shape the live verifier (crossCheckBuildContext)
    // now accepts for null claims: repository/ref/path → '', commit omitted.
    const wf = stmt.predicate.buildDefinition.externalParameters.workflow;
    expect(wf.repository).toBe('');
    expect(wf.ref).toBe('');
    expect(wf.path).toBe('');
    const ip = stmt.predicate.buildDefinition.internalParameters ?? {};
    expect('commit' in ip).toBe(false);
    expect(stmt.predicate.runDetails.builder.id).toBe('https://issuer/orchestrator/unknown');
  });

  it('embeds org-id origin, source-origin brand, and provider', () => {
    const stmt = buildProvenanceStatement({
      tokenClaims: {
        iss: 'https://api.kici.dev',
        repository: 'local/x',
        ref: 'main',
        sha: undefined,
        workflow_ref: 'ci',
        kici_run_id: 'r1',
        kici_job_id: 'j1',
        orchestrator_id: 'o1',
        org_id: 'org_abc123',
        source_origin: 'run-remote',
        provider: 'local',
      },
      subject: { name: 'art', digest: { sha256: 'a'.repeat(64) } },
      builderVersions: { 'kici-agent': '1', 'kici-orchestrator': '1' },
      startedOn: '2026-06-29T00:00:00+00:00',
      finishedOn: '2026-06-29T00:01:00+00:00',
    });
    expect(kiciProvenanceStatementSchema.safeParse(stmt).success).toBe(true);
    expect(stmt.predicate.buildDefinition.internalParameters?.orgId).toBe('org_abc123');
    expect(stmt.predicate.buildDefinition.internalParameters?.sourceOrigin).toBe('run-remote');
    expect(stmt.predicate.buildDefinition.externalParameters.provider).toBe('local');
  });

  it('omits brand fields when the claims do not carry them (triggered legacy path)', () => {
    const stmt = buildProvenanceStatement({
      tokenClaims: claims,
      subject: { name: 'art', digest: { sha256: 'a'.repeat(64) } },
      builderVersions: { 'kici-agent': '1', 'kici-orchestrator': '1' },
      startedOn: '2026-06-29T00:00:00+00:00',
      finishedOn: '2026-06-29T00:01:00+00:00',
    });
    expect(stmt.predicate.buildDefinition.internalParameters?.sourceOrigin).toBeUndefined();
    expect(stmt.predicate.buildDefinition.internalParameters?.orgId).toBeUndefined();
    expect(stmt.predicate.buildDefinition.externalParameters.provider).toBeUndefined();
  });
});

describe('buildLocalProvenanceStatement — cross-checkable against a live mint', () => {
  const VERSIONS = { 'kici-agent': '0.7.1', 'kici-orchestrator': '0.7.1' } as const;
  const SUBJECT = { name: 'pkg', digest: { sha256: 'a'.repeat(64) } };
  const TIMES = {
    startedOn: '2026-06-11T00:00:00.000Z',
    finishedOn: '2026-06-11T00:01:00.000Z',
  };

  /** The orchestrator's context, derived from the same run row the mint reads. */
  const context = {
    repository: claims.repository,
    ref: claims.ref,
    sha: claims.sha,
    workflowRef: claims.workflow_ref,
    runId: claims.kici_run_id,
    jobId: claims.kici_job_id,
    orgId: 'org-1',
    sourceOrigin: 'triggered' as const,
    provider: 'github',
    issuer: claims.iss,
    orchestratorId: claims.orchestrator_id,
  };

  it('produces a statement the engine verifier accepts against the minted claims', () => {
    const frozen = buildLocalProvenanceStatement({
      context,
      subject: SUBJECT,
      builderVersions: VERSIONS,
      ...TIMES,
    });
    expect(() => kiciProvenanceStatementSchema.parse(frozen)).not.toThrow();
    expect(crossCheckBuildContext(frozen, claims)).toBe(true);
  });

  it('agrees field-for-field with what a live mint would have produced', () => {
    const frozen = buildLocalProvenanceStatement({
      context,
      subject: SUBJECT,
      builderVersions: VERSIONS,
      ...TIMES,
    });
    const live = buildProvenanceStatement({
      tokenClaims: { ...claims, org_id: 'org-1', source_origin: 'triggered', provider: 'github' },
      subject: SUBJECT,
      builderVersions: VERSIONS,
      ...TIMES,
    });

    // The ONLY difference is the deferred marker. Anything else would be a
    // field the capture cross-check would reject on every legitimate defer.
    const stripOrigin = (s: typeof frozen) => {
      const ip = { ...s.predicate.buildDefinition.internalParameters };
      delete (ip as Record<string, unknown>).attestationOrigin;
      return {
        ...s,
        predicate: {
          ...s.predicate,
          buildDefinition: { ...s.predicate.buildDefinition, internalParameters: ip },
        },
      };
    };
    expect(stripOrigin(frozen)).toEqual(stripOrigin(live));
    expect(frozen.predicate.buildDefinition.internalParameters?.attestationOrigin).toBe('deferred');
  });

  it('records the real builder id, not /orchestrator/unknown', () => {
    const frozen = buildLocalProvenanceStatement({
      context,
      subject: SUBJECT,
      builderVersions: VERSIONS,
      ...TIMES,
    });
    expect(frozen.predicate.runDetails.builder.id).toBe(
      `${claims.iss}/orchestrator/${claims.orchestrator_id}`,
    );
  });

  it('still builds a schema-valid statement with no orchestrator context', () => {
    // The fallback an older orchestrator's dispatch leaves the agent with. It
    // is schema-valid, and it fails the capture cross-check — which is the
    // point: the defer is dropped rather than stored unchecked.
    const fallback = buildLocalProvenanceStatement({
      context: {
        repository: 'acme/app',
        ref: 'patch-1', // the job's CHECKOUT ref, not the base branch
        sha: claims.sha,
        workflowRef: '', // a global workflow's clone ref, not `<name>@<sha>`
        runId: claims.kici_run_id,
        jobId: claims.kici_job_id,
        issuer: '',
      },
      subject: SUBJECT,
      builderVersions: VERSIONS,
      ...TIMES,
    });
    expect(() => kiciProvenanceStatementSchema.parse(fallback)).not.toThrow();
    expect(crossCheckBuildContext(fallback, claims)).toBe(false);
  });
});

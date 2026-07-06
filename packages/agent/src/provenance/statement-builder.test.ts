import { describe, expect, it } from 'vitest';
import { kiciProvenanceStatementSchema } from '@kici-dev/engine/provenance/schema';
import { buildProvenanceStatement } from './statement-builder.js';

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

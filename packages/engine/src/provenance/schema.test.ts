import { describe, expect, it } from 'vitest';
import {
  DigestAlgorithm,
  IN_TOTO_STATEMENT_TYPE,
  KICI_WORKFLOW_BUILD_TYPE,
  SLSA_PROVENANCE_PREDICATE_TYPE,
  digestSetSchema,
  inTotoStatementSchema,
  kiciBuildDefinitionSchema,
  kiciProvenanceStatementSchema,
  resourceDescriptorSchema,
  slsaProvenancePredicateSchema,
  subjectSchema,
} from './schema.js';

describe('constants', () => {
  it('exposes the pinned in-toto / SLSA / KiCI URIs', () => {
    expect(IN_TOTO_STATEMENT_TYPE).toBe('https://in-toto.io/Statement/v1');
    expect(SLSA_PROVENANCE_PREDICATE_TYPE).toBe('https://slsa.dev/provenance/v1');
    expect(KICI_WORKFLOW_BUILD_TYPE).toBe('https://kici.dev/buildtypes/workflow/v1');
  });

  it('enumerates the known digest algorithms', () => {
    expect(DigestAlgorithm.options).toContain('sha512');
    expect(DigestAlgorithm.options).toContain('sha256');
  });
});

describe('digestSetSchema', () => {
  it('accepts a lowercase-hex digest', () => {
    expect(digestSetSchema.parse({ [DigestAlgorithm.enum.sha512]: 'deadbeef' })).toEqual({
      sha512: 'deadbeef',
    });
  });

  it('rejects an uppercase-hex digest', () => {
    expect(digestSetSchema.safeParse({ sha512: 'DEADBEEF' }).success).toBe(false);
  });

  it('rejects a non-hex digest', () => {
    expect(digestSetSchema.safeParse({ sha512: 'not-hex!' }).success).toBe(false);
  });

  it('rejects an empty digest set', () => {
    expect(digestSetSchema.safeParse({}).success).toBe(false);
  });
});

describe('resourceDescriptorSchema', () => {
  it('accepts a descriptor with only a name', () => {
    expect(resourceDescriptorSchema.safeParse({ name: 'build-log' }).success).toBe(true);
  });

  it('rejects an empty descriptor (no name/uri/digest)', () => {
    expect(resourceDescriptorSchema.safeParse({ mediaType: 'text/plain' }).success).toBe(false);
  });
});

describe('subjectSchema', () => {
  it('requires a digest', () => {
    expect(subjectSchema.safeParse({ name: 'pkg:npm/@acme/api@1.0.0' }).success).toBe(false);
    expect(
      subjectSchema.safeParse({
        name: 'pkg:npm/@acme/api@1.0.0',
        digest: { sha512: 'cafe' },
      }).success,
    ).toBe(true);
  });
});

describe('slsaProvenancePredicateSchema (generic)', () => {
  const predicate = {
    buildDefinition: {
      buildType: 'https://example.com/buildtypes/custom/v1',
      externalParameters: { anything: 'goes' },
    },
    runDetails: {
      builder: { id: 'https://example.com/builder/1' },
    },
  };

  it('accepts a minimal predicate with a non-KiCI buildType', () => {
    expect(slsaProvenancePredicateSchema.safeParse(predicate).success).toBe(true);
  });

  it('requires builder.id', () => {
    expect(
      slsaProvenancePredicateSchema.safeParse({
        buildDefinition: predicate.buildDefinition,
        runDetails: { builder: {} },
      }).success,
    ).toBe(false);
  });

  it('requires buildDefinition.externalParameters', () => {
    expect(
      slsaProvenancePredicateSchema.safeParse({
        buildDefinition: { buildType: 'https://example.com/b' },
        runDetails: predicate.runDetails,
      }).success,
    ).toBe(false);
  });
});

describe('inTotoStatementSchema (generic envelope)', () => {
  const statement = {
    _type: 'https://in-toto.io/Statement/v1',
    subject: [{ name: 'pkg:npm/@acme/api@1.0.0', digest: { sha512: 'cafe' } }],
    predicateType: 'https://example.com/predicate/v1',
    predicate: { any: 'shape' },
  };

  it('accepts a generic statement', () => {
    expect(inTotoStatementSchema.safeParse(statement).success).toBe(true);
  });

  it('rejects a wrong _type', () => {
    expect(inTotoStatementSchema.safeParse({ ...statement, _type: 'https://wrong' }).success).toBe(
      false,
    );
  });

  it('rejects an empty subject array', () => {
    expect(inTotoStatementSchema.safeParse({ ...statement, subject: [] }).success).toBe(false);
  });
});

const validKiciStatement = {
  _type: IN_TOTO_STATEMENT_TYPE,
  subject: [{ name: 'pkg:npm/@kici-dev/sdk@0.4.2', digest: { sha512: 'deadbeef' } }],
  predicateType: SLSA_PROVENANCE_PREDICATE_TYPE,
  predicate: {
    buildDefinition: {
      buildType: KICI_WORKFLOW_BUILD_TYPE,
      externalParameters: {
        workflow: {
          repository: 'github.com/acme/api',
          ref: 'refs/tags/v0.4.2',
          path: '.kici/workflows/release.ts',
        },
      },
      internalParameters: { commit: 'deadbeef', runId: 'run-1', jobId: 'job-1' },
      resolvedDependencies: [
        { uri: 'git+https://github.com/acme/api', digest: { gitCommit: 'deadbeef' } },
      ],
    },
    runDetails: {
      builder: {
        id: 'https://kici.dev/orchestrator/orch-1',
        version: { 'kici-orchestrator': '0.7.1', 'kici-agent': '0.7.1' },
      },
      metadata: {
        invocationId: 'run-1',
        startedOn: '2026-05-12T06:25:52Z',
        finishedOn: '2026-05-12T06:31:14Z',
      },
      byproducts: [{ name: 'build-log', digest: { sha256: 'cafe' } }],
    },
  },
};

describe('kiciProvenanceStatementSchema', () => {
  it('parses a full valid KiCI statement', () => {
    expect(kiciProvenanceStatementSchema.parse(validKiciStatement)).toBeDefined();
  });

  it('parses a minimal-required KiCI statement', () => {
    const minimal = {
      _type: IN_TOTO_STATEMENT_TYPE,
      subject: [{ digest: { sha512: 'cafe' } }],
      predicateType: SLSA_PROVENANCE_PREDICATE_TYPE,
      predicate: {
        buildDefinition: {
          buildType: KICI_WORKFLOW_BUILD_TYPE,
          externalParameters: {
            workflow: { repository: 'r', ref: 'refs/heads/main', path: '.kici/workflows/x.ts' },
          },
        },
        runDetails: { builder: { id: 'https://kici.dev/orchestrator/o' } },
      },
    };
    expect(kiciProvenanceStatementSchema.safeParse(minimal).success).toBe(true);
  });

  it('rejects a non-KiCI buildType (literal pin)', () => {
    const wrong = structuredClone(validKiciStatement);
    wrong.predicate.buildDefinition.buildType = 'https://example.com/other';
    expect(kiciProvenanceStatementSchema.safeParse(wrong).success).toBe(false);
  });

  it('rejects a wrong predicateType', () => {
    const wrong = structuredClone(validKiciStatement);
    wrong.predicateType = 'https://example.com/predicate/v1';
    expect(kiciProvenanceStatementSchema.safeParse(wrong).success).toBe(false);
  });

  it('rejects missing workflow in external parameters', () => {
    const wrong = structuredClone(validKiciStatement);
    // @ts-expect-error deliberately removing a required field for the negative case
    delete wrong.predicate.buildDefinition.externalParameters.workflow;
    expect(kiciProvenanceStatementSchema.safeParse(wrong).success).toBe(false);
  });

  it('tolerates extra/unknown keys in external parameters (passthrough)', () => {
    const extra = structuredClone(validKiciStatement);
    (extra.predicate.buildDefinition.externalParameters as Record<string, unknown>).futureField =
      'ok';
    expect(kiciProvenanceStatementSchema.safeParse(extra).success).toBe(true);
  });

  it('round-trips through JSON unchanged', () => {
    const parsed = kiciProvenanceStatementSchema.parse(
      JSON.parse(JSON.stringify(validKiciStatement)),
    );
    expect(parsed).toEqual(validKiciStatement);
  });
});

describe('kiciBuildDefinitionSchema', () => {
  it('inherits resolvedDependencies from the generic build definition', () => {
    const bd = {
      buildType: KICI_WORKFLOW_BUILD_TYPE,
      externalParameters: {
        workflow: { repository: 'r', ref: 'refs/heads/main', path: 'p' },
      },
      resolvedDependencies: [{ uri: 'git+https://x', digest: { gitCommit: 'beef' } }],
    };
    expect(kiciBuildDefinitionSchema.safeParse(bd).success).toBe(true);
  });
});

import { describe, it, expect } from 'vitest';
import {
  GIT_CREDENTIAL_REQUEST_METHOD,
  gitCredentialRequestParamsSchema,
  gitCredentialResultSchema,
} from './git-credential-relay.js';

describe('git credential relay protocol', () => {
  it('names the method', () => {
    expect(GIT_CREDENTIAL_REQUEST_METHOD).toBe('git.credential.request');
  });

  it('accepts a minimal source-credential request', () => {
    const parsed = gitCredentialRequestParamsSchema.parse({
      jobId: 'job-1',
      repositories: ['kici-dev/kici-forge-app-token-tester'],
    });
    expect(parsed.repositories).toEqual(['kici-dev/kici-forge-app-token-tester']);
    expect(parsed.ref).toBeUndefined();
  });

  it('accepts several repositories and rejects an empty list', () => {
    const parsed = gitCredentialRequestParamsSchema.parse({
      jobId: 'job-1',
      repositories: ['kici-dev/one', 'kici-dev/two'],
    });
    expect(parsed.repositories).toEqual(['kici-dev/one', 'kici-dev/two']);

    // An empty list would mint across the whole installation.
    expect(() =>
      gitCredentialRequestParamsSchema.parse({ jobId: 'job-1', repositories: [] }),
    ).toThrow();
  });

  it('rejects a wildcard anywhere in the list, not only first', () => {
    expect(() =>
      gitCredentialRequestParamsSchema.parse({
        jobId: 'job-1',
        repositories: ['kici-dev/ok', 'kici-dev/*'],
      }),
    ).toThrow();
  });

  it('accepts a workflow-supplied app ref', () => {
    const parsed = gitCredentialRequestParamsSchema.parse({
      jobId: 'job-1',
      repositories: ['kici-dev/kici-forge-app-token-tester'],
      ref: {
        kind: 'app',
        appIdSecret: 'ci:A',
        installationIdSecret: 'ci:I',
        privateKeySecret: 'ci:K',
      },
      permissions: { contents: 'write', workflows: 'write' },
    });
    expect(parsed.ref?.kind).toBe('app');
  });

  it('accepts runtime material through the *Value half', () => {
    const parsed = gitCredentialRequestParamsSchema.parse({
      jobId: 'job-1',
      repositories: ['a/b'],
      ref: { kind: 'token', tokenValue: 'runtime-material' },
    });
    expect(parsed.ref?.kind).toBe('token');
  });

  it('rejects a wildcard repository', () => {
    expect(() =>
      gitCredentialRequestParamsSchema.parse({ jobId: 'job-1', repositories: ['kici-dev/*'] }),
    ).toThrow(/explicit/i);
  });

  it('rejects an app ref missing its installation id', () => {
    expect(() =>
      gitCredentialRequestParamsSchema.parse({
        jobId: 'job-1',
        repositories: ['a/b'],
        ref: { kind: 'app', appIdSecret: 'ci:A', privateKeySecret: 'ci:K' },
      }),
    ).toThrow();
  });

  it('rejects an unqualified secret reference', () => {
    expect(() =>
      gitCredentialRequestParamsSchema.parse({
        jobId: 'job-1',
        repositories: ['a/b'],
        ref: { kind: 'token', tokenSecret: 'FORGE_PAT' },
      }),
    ).toThrow(/qualified/i);
  });

  it('rejects credential material where a secret name belongs', () => {
    expect(() =>
      gitCredentialRequestParamsSchema.parse({
        jobId: 'job-1',
        repositories: ['a/b'],
        ref: { kind: 'ssh', privateKeySecret: '-----BEGIN RSA PRIVATE KEY-----\nMII' },
      }),
    ).toThrow(/privateKeyValue/);
  });

  it('rejects setting both halves of a pair', () => {
    expect(() =>
      gitCredentialRequestParamsSchema.parse({
        jobId: 'job-1',
        repositories: ['a/b'],
        ref: { kind: 'token', tokenSecret: 'ci:FORGE_PAT', tokenValue: 'material' },
      }),
    ).toThrow(/exactly one/i);
  });

  it('round-trips an unscoped grant', () => {
    const parsed = gitCredentialResultSchema.parse({
      kind: 'basic',
      user: 'x-access-token',
      secret: 's',
      grant: { scoped: false },
      expiresAt: null,
    });
    expect(parsed.grant.scoped).toBe(false);
  });
});

import { describe, expect, it } from 'vitest';
import {
  jobDispatchSchema,
  jobCancelSchema,
  jobRejectSchema,
  jobAckSchema,
  JobRejectReason,
  registerAckSchema,
  agentRegisterSchema,
  agentStatusSchema,
  jobStatusSchema,
  agentLogChunkSchema,
  agentStepStatusSchema,
  configAckSchema,
  eventEmitSchema,
  eventEmitResponseSchema,
  agentAuthRequestSchema,
  agentAuthSuccessSchema,
  agentAuthFailureSchema,
  orchestratorToAgentMessageSchema,
  agentToOrchestratorMessageSchema,
  jobConcurrencyReportSchema,
  jobConcurrencyAckSchema,
  gitAuthSchema,
  CacheRefScope,
  cacheUserRestoreRequestSchema,
  cacheUserRestoreResponseSchema,
  cacheUserSaveRequestSchema,
  cacheUserSaveResponseSchema,
  cacheUserSaveCompleteSchema,
  stepApprovalRequestSchema,
  stepApprovalResolvedSchema,
  StepApprovalOutcome,
  upstreamSnapshotSchema,
} from './orchestrator-agent.js';

// --- Individual schema tests ---

describe('upstreamSnapshotSchema', () => {
  it('accepts jobs + groups', () => {
    const parsed = upstreamSnapshotSchema.parse({
      jobs: { discover: { targets: ['a'] }, 'scan-a': { findings: 1 } },
      groups: { 'scan-shards': ['scan-a'] },
    });
    expect(parsed.groups['scan-shards']).toEqual(['scan-a']);
    expect(parsed.jobs.discover).toEqual({ targets: ['a'] });
  });

  it('accepts empty jobs/groups maps', () => {
    expect(upstreamSnapshotSchema.parse({ jobs: {}, groups: {} })).toEqual({
      jobs: {},
      groups: {},
    });
  });

  it('rejects a non-array group membership', () => {
    expect(() => upstreamSnapshotSchema.parse({ jobs: {}, groups: { g: 'x' } })).toThrow();
  });
});

describe('jobDispatchSchema', () => {
  const validDispatch = {
    type: 'job.dispatch',
    messageId: 'msg-400',
    runId: 'run-001',
    jobId: 'build',
    repoUrl: 'https://github.com/org/repo.git',
    ref: 'refs/heads/main',
    sha: 'abc123def456',
    lockFileUrl: 'https://storage.example.com/lock/run-001.json',
    jobConfig: { steps: [], needs: [] },
    timestamp: Date.now(),
  };

  it('validates a well-formed dispatch message', () => {
    expect(jobDispatchSchema.parse(validDispatch)).toEqual(validDispatch);
  });

  it('rejects missing repoUrl', () => {
    const { repoUrl, ...rest } = validDispatch;
    expect(() => jobDispatchSchema.parse(rest)).toThrow();
  });

  it('rejects missing sha', () => {
    const { sha, ...rest } = validDispatch;
    expect(() => jobDispatchSchema.parse(rest)).toThrow();
  });

  it('round-trips through JSON serialization', () => {
    const roundTripped = JSON.parse(JSON.stringify(validDispatch));
    expect(jobDispatchSchema.parse(roundTripped)).toEqual(validDispatch);
  });

  it('parses successfully with all new optional fields present', () => {
    const withNewFields = {
      ...validDispatch,
      token: 'ghs_abc123xyz',
      secrets: { NPM_TOKEN: 'npm_xxxx', DEPLOY_KEY: 'deploy_yyyy' },
      maxLogSizeBytes: 5242880,
    };
    const parsed = jobDispatchSchema.parse(withNewFields);
    expect(parsed.token).toBe('ghs_abc123xyz');
    expect(parsed.secrets).toEqual({ NPM_TOKEN: 'npm_xxxx', DEPLOY_KEY: 'deploy_yyyy' });
    expect(parsed.maxLogSizeBytes).toBe(5242880);
  });

  it('parses successfully without the new optional fields (backward compatibility)', () => {
    const parsed = jobDispatchSchema.parse(validDispatch);
    expect(parsed.token).toBeUndefined();
    expect(parsed.secrets).toBeUndefined();
    expect(parsed.maxLogSizeBytes).toBeUndefined();
  });

  it('coerces maxLogSizeBytes from string to number', () => {
    const withStringSize = { ...validDispatch, maxLogSizeBytes: '10485760' };
    const parsed = jobDispatchSchema.parse(withStringSize);
    expect(parsed.maxLogSizeBytes).toBe(10485760);
    expect(typeof parsed.maxLogSizeBytes).toBe('number');
  });

  it('validates secrets as Record<string, string>', () => {
    const withSecrets = { ...validDispatch, secrets: { KEY1: 'val1', KEY2: 'val2' } };
    const parsed = jobDispatchSchema.parse(withSecrets);
    expect(parsed.secrets).toEqual({ KEY1: 'val1', KEY2: 'val2' });
  });

  it('rejects secrets with non-string values', () => {
    const badSecrets = { ...validDispatch, secrets: { KEY1: 123 } };
    expect(() => jobDispatchSchema.parse(badSecrets)).toThrow();
  });

  it('accepts optional requestId for distributed tracing', () => {
    const msg = { ...validDispatch, requestId: '550e8400-e29b-41d4-a716-446655440000' };
    const parsed = jobDispatchSchema.parse(msg);
    expect(parsed.requestId).toBe('550e8400-e29b-41d4-a716-446655440000');
  });

  it('parses successfully without requestId (backward compatibility)', () => {
    const parsed = jobDispatchSchema.parse(validDispatch);
    expect(parsed.requestId).toBeUndefined();
  });

  it('accepts optional runPublicKey for cross-job secret encryption', () => {
    const msg = { ...validDispatch, runPublicKey: 'MCowBQYDK2VuAyEA...' };
    const parsed = jobDispatchSchema.parse(msg);
    expect(parsed.runPublicKey).toBe('MCowBQYDK2VuAyEA...');
  });

  it('parses successfully without runPublicKey (backward compatibility)', () => {
    const parsed = jobDispatchSchema.parse(validDispatch);
    expect(parsed.runPublicKey).toBeUndefined();
  });

  // --- Phase 4: structured sourceAuth / workflowAuth ---

  it('accepts structured sourceAuth with kind=basic', () => {
    const msg = {
      ...validDispatch,
      sourceAuth: { kind: 'basic', user: 'x-access-token', secret: 'ghs_abc' },
    };
    const parsed = jobDispatchSchema.parse(msg);
    expect(parsed.sourceAuth).toEqual({
      kind: 'basic',
      user: 'x-access-token',
      secret: 'ghs_abc',
    });
  });

  it('accepts structured sourceAuth with kind=ssh including host-key policy', () => {
    const msg = {
      ...validDispatch,
      sourceAuth: {
        kind: 'ssh',
        secret: '-----BEGIN KEY-----',
        sshHostKeyPolicy: 'pinned',
        sshKnownHostsPem: 'forgejo.example.com ssh-ed25519 AAAA...',
      },
    };
    const parsed = jobDispatchSchema.parse(msg);
    expect(parsed.sourceAuth?.kind).toBe('ssh');
    expect(parsed.sourceAuth?.sshHostKeyPolicy).toBe('pinned');
  });

  it('accepts both sourceAuth and workflowAuth for cross-provider globals', () => {
    const msg = {
      ...validDispatch,
      jobConfig: { isGlobalWorkflow: true },
      sourceAuth: { kind: 'basic', user: 'x-access-token', secret: 'forgejo-pat' },
      workflowAuth: { kind: 'basic', user: 'x-access-token', secret: 'ghs_github' },
    };
    const parsed = jobDispatchSchema.parse(msg);
    expect(parsed.sourceAuth?.secret).toBe('forgejo-pat');
    expect(parsed.workflowAuth?.secret).toBe('ghs_github');
  });

  it('accepts token alongside matching basic sourceAuth (transition-window compat)', () => {
    const msg = {
      ...validDispatch,
      token: 'ghs_abc',
      sourceAuth: { kind: 'basic', user: 'x-access-token', secret: 'ghs_abc' },
    };
    expect(jobDispatchSchema.parse(msg)).toBeDefined();
  });

  it('rejects token + sourceAuth when secrets disagree', () => {
    const msg = {
      ...validDispatch,
      token: 'ghs_abc',
      sourceAuth: { kind: 'basic', user: 'x-access-token', secret: 'different_token' },
    };
    expect(() => jobDispatchSchema.parse(msg)).toThrow(/token and sourceAuth.secret must match/);
  });

  it('rejects token + sourceAuth when kind is ssh (token cannot represent ssh)', () => {
    const msg = {
      ...validDispatch,
      token: 'ghs_abc',
      sourceAuth: { kind: 'ssh', secret: '-----BEGIN KEY-----' },
    };
    // The Zod error is emitted as a JSON-serialized issue array where
    // double-quotes are backslash-escaped — match the escape-free substring.
    expect(() => jobDispatchSchema.parse(msg)).toThrow(/sourceAuth\.kind must be/);
  });

  it('parses job.dispatch with org/repo/cacheRefScope', () => {
    const parsed = jobDispatchSchema.parse({
      ...validDispatch,
      orgId: 'org-1',
      repoId: 'owner/repo',
      cacheRefScope: CacheRefScope.enum.shared,
    });
    expect(parsed.orgId).toBe('org-1');
    expect(parsed.repoId).toBe('owner/repo');
    expect(parsed.cacheRefScope).toBe(CacheRefScope.enum.shared);
  });

  it('parses job.dispatch without org/repo/cacheRefScope (backward compat)', () => {
    const parsed = jobDispatchSchema.parse(validDispatch);
    expect(parsed.orgId).toBeUndefined();
    expect(parsed.repoId).toBeUndefined();
    expect(parsed.cacheRefScope).toBeUndefined();
  });

  it('rejects an invalid cacheRefScope value', () => {
    expect(() => jobDispatchSchema.parse({ ...validDispatch, cacheRefScope: 'public' })).toThrow();
  });
});

// --- User-facing cache protocol tests ---

describe('CacheRefScope', () => {
  it('enumerates shared and isolated', () => {
    expect(CacheRefScope.options).toEqual([CacheRefScope.enum.shared, CacheRefScope.enum.isolated]);
    expect(CacheRefScope.options).toEqual(['shared', 'isolated']);
  });
});

describe('cacheUserRestoreRequestSchema', () => {
  it('parses a well-formed restore request', () => {
    const m = cacheUserRestoreRequestSchema.parse({
      type: 'cache.user.restore.request',
      messageId: 'm1',
      jobId: 'j1',
      key: 'k',
      restoreKeys: ['p-'],
    });
    expect(m.key).toBe('k');
    expect(m.restoreKeys).toEqual(['p-']);
  });

  it('parses without restoreKeys (optional)', () => {
    const m = cacheUserRestoreRequestSchema.parse({
      type: 'cache.user.restore.request',
      messageId: 'm1',
      jobId: 'j1',
      key: 'k',
    });
    expect(m.restoreKeys).toBeUndefined();
  });
});

describe('cacheUserRestoreResponseSchema', () => {
  it('parses a hit response with download URL', () => {
    const m = cacheUserRestoreResponseSchema.parse({
      type: 'cache.user.restore.response',
      requestId: 'm1',
      hit: true,
      matchedKey: 'k',
      downloadUrl: 'https://s3/get',
      tarHash: 'deadbeef',
    });
    expect(m.hit).toBe(true);
    expect(m.downloadUrl).toBe('https://s3/get');
  });

  it('parses a miss response', () => {
    const m = cacheUserRestoreResponseSchema.parse({
      type: 'cache.user.restore.response',
      requestId: 'm1',
      hit: false,
    });
    expect(m.hit).toBe(false);
    expect(m.matchedKey).toBeUndefined();
  });
});

describe('cacheUserSaveRequestSchema', () => {
  it('parses a well-formed save request', () => {
    const m = cacheUserSaveRequestSchema.parse({
      type: 'cache.user.save.request',
      messageId: 'm1',
      jobId: 'j1',
      key: 'k',
    });
    expect(m.key).toBe('k');
  });
});

describe('cacheUserSaveResponseSchema', () => {
  it('parses a presigned-upload response', () => {
    const m = cacheUserSaveResponseSchema.parse({
      type: 'cache.user.save.response',
      requestId: 'm1',
      uploadUrl: 'https://s3/put',
      skip: false,
    });
    expect(m.skip).toBe(false);
    expect(m.uploadUrl).toBe('https://s3/put');
  });

  it('parses a skip response without uploadUrl', () => {
    const m = cacheUserSaveResponseSchema.parse({
      type: 'cache.user.save.response',
      requestId: 'm1',
      skip: true,
    });
    expect(m.skip).toBe(true);
    expect(m.uploadUrl).toBeUndefined();
  });
});

describe('cacheUserSaveCompleteSchema', () => {
  it('parses a well-formed save complete', () => {
    const m = cacheUserSaveCompleteSchema.parse({
      type: 'cache.user.save.complete',
      messageId: 'm1',
      jobId: 'j1',
      key: 'k',
      tarHash: 'deadbeef',
      sizeBytes: 1234,
    });
    expect(m.sizeBytes).toBe(1234);
    expect(m.tarHash).toBe('deadbeef');
  });

  it('rejects a negative sizeBytes', () => {
    expect(() =>
      cacheUserSaveCompleteSchema.parse({
        type: 'cache.user.save.complete',
        messageId: 'm1',
        jobId: 'j1',
        key: 'k',
        tarHash: 'h',
        sizeBytes: -1,
      }),
    ).toThrow();
  });
});

describe('user-cache union discrimination', () => {
  it('agentToOrchestratorMessageSchema accepts cache.user.restore.request', () => {
    const msg = {
      type: 'cache.user.restore.request',
      messageId: 'm1',
      jobId: 'j1',
      key: 'k',
    };
    expect(agentToOrchestratorMessageSchema.parse(msg)).toEqual(msg);
  });

  it('agentToOrchestratorMessageSchema accepts cache.user.save.request', () => {
    const msg = {
      type: 'cache.user.save.request',
      messageId: 'm1',
      jobId: 'j1',
      key: 'k',
    };
    expect(agentToOrchestratorMessageSchema.parse(msg)).toEqual(msg);
  });

  it('agentToOrchestratorMessageSchema accepts cache.user.save.complete', () => {
    const msg = {
      type: 'cache.user.save.complete',
      messageId: 'm1',
      jobId: 'j1',
      key: 'k',
      tarHash: 'h',
      sizeBytes: 10,
    };
    expect(agentToOrchestratorMessageSchema.parse(msg)).toEqual(msg);
  });

  it('orchestratorToAgentMessageSchema accepts cache.user.restore.response', () => {
    const msg = { type: 'cache.user.restore.response', requestId: 'm1', hit: false };
    expect(orchestratorToAgentMessageSchema.parse(msg)).toEqual(msg);
  });

  it('orchestratorToAgentMessageSchema accepts cache.user.save.response', () => {
    const msg = { type: 'cache.user.save.response', requestId: 'm1', skip: true };
    expect(orchestratorToAgentMessageSchema.parse(msg)).toEqual(msg);
  });

  it('orchestratorToAgentMessageSchema rejects cache.user.restore.request (wrong direction)', () => {
    const msg = {
      type: 'cache.user.restore.request',
      messageId: 'm1',
      jobId: 'j1',
      key: 'k',
    };
    expect(() => orchestratorToAgentMessageSchema.parse(msg)).toThrow();
  });
});

describe('gitAuthSchema', () => {
  it('accepts kind=basic with user and secret', () => {
    expect(gitAuthSchema.parse({ kind: 'basic', user: 'alice', secret: 'pw' })).toEqual({
      kind: 'basic',
      user: 'alice',
      secret: 'pw',
    });
  });

  it('accepts kind=ssh with secret only (accept-new host key policy)', () => {
    const parsed = gitAuthSchema.parse({
      kind: 'ssh',
      secret: '-----BEGIN KEY-----',
      sshHostKeyPolicy: 'accept-new',
    });
    expect(parsed.sshHostKeyPolicy).toBe('accept-new');
    expect(parsed.user).toBeUndefined();
  });

  it('rejects unknown kind values', () => {
    expect(() => gitAuthSchema.parse({ kind: 'token', secret: 's' })).toThrow();
  });

  it('rejects invalid host-key policy', () => {
    expect(() =>
      gitAuthSchema.parse({ kind: 'ssh', secret: 's', sshHostKeyPolicy: 'ignore' }),
    ).toThrow();
  });

  it('rejects kind=ssh with pinned policy but no sshKnownHostsPem', () => {
    expect(() =>
      gitAuthSchema.parse({
        kind: 'ssh',
        secret: '-----BEGIN KEY-----',
        sshHostKeyPolicy: 'pinned',
      }),
    ).toThrow(/sshKnownHostsPem is required when sshHostKeyPolicy is/);
  });

  it('rejects kind=ssh with pinned policy and empty sshKnownHostsPem', () => {
    expect(() =>
      gitAuthSchema.parse({
        kind: 'ssh',
        secret: '-----BEGIN KEY-----',
        sshHostKeyPolicy: 'pinned',
        sshKnownHostsPem: '',
      }),
    ).toThrow(/sshKnownHostsPem is required when sshHostKeyPolicy is/);
  });

  it('accepts kind=basic with pinned-style fields ignored (refinement is SSH-only)', () => {
    // Refinement should not fire for kind=basic even if pinned policy is somehow set
    // (e.g. stale configuration that switched kinds without clearing SSH-only fields).
    expect(() =>
      gitAuthSchema.parse({
        kind: 'basic',
        user: 'x-access-token',
        secret: 'pat',
        sshHostKeyPolicy: 'pinned',
      }),
    ).not.toThrow();
  });
});

describe('jobCancelSchema', () => {
  const validCancel = {
    type: 'job.cancel',
    messageId: 'msg-401',
    runId: 'run-001',
    jobId: 'build',
    reason: 'superseded by newer push',
  };

  it('validates a well-formed cancel message', () => {
    expect(jobCancelSchema.parse(validCancel)).toEqual(validCancel);
  });

  it('rejects missing reason', () => {
    const { reason, ...rest } = validCancel;
    expect(() => jobCancelSchema.parse(rest)).toThrow();
  });

  it('round-trips through JSON serialization', () => {
    const roundTripped = JSON.parse(JSON.stringify(validCancel));
    expect(jobCancelSchema.parse(roundTripped)).toEqual(validCancel);
  });
});

describe('agentRegisterSchema', () => {
  const validRegister = {
    type: 'agent.register',
    messageId: 'msg-500',
    agentId: 'agent-1',
    labels: ['linux', 'x64', 'docker'],
  };

  it('validates a well-formed register message', () => {
    expect(agentRegisterSchema.parse(validRegister)).toEqual(validRegister);
  });

  it('accepts empty labels array', () => {
    expect(agentRegisterSchema.parse({ ...validRegister, labels: [] })).toBeDefined();
  });

  it('rejects missing agentId', () => {
    const { agentId, ...rest } = validRegister;
    expect(() => agentRegisterSchema.parse(rest)).toThrow();
  });

  it('round-trips through JSON serialization', () => {
    const roundTripped = JSON.parse(JSON.stringify(validRegister));
    expect(agentRegisterSchema.parse(roundTripped)).toEqual(validRegister);
  });
});

describe('agentStatusSchema', () => {
  const validStatus = {
    type: 'agent.status',
    messageId: 'msg-501',
    agentId: 'agent-1',
    activeJobs: 2,
  };

  it('validates a well-formed status message', () => {
    expect(agentStatusSchema.parse(validStatus)).toEqual(validStatus);
  });

  it('rejects missing activeJobs', () => {
    const { activeJobs, ...rest } = validStatus;
    expect(() => agentStatusSchema.parse(rest)).toThrow();
  });

  it('round-trips through JSON serialization', () => {
    const roundTripped = JSON.parse(JSON.stringify(validStatus));
    expect(agentStatusSchema.parse(roundTripped)).toEqual(validStatus);
  });
});

describe('jobStatusSchema', () => {
  const validJobStatus = {
    type: 'job.status',
    messageId: 'msg-502',
    runId: 'run-001',
    jobId: 'build',
    state: 'running',
    timestamp: Date.now(),
  };

  it('validates a well-formed job status message', () => {
    expect(jobStatusSchema.parse(validJobStatus)).toEqual(validJobStatus);
  });

  it('validates all valid state values', () => {
    const states = ['pending', 'queued', 'running', 'success', 'failed', 'cancelled', 'skipped'];
    for (const state of states) {
      expect(jobStatusSchema.parse({ ...validJobStatus, state })).toBeDefined();
    }
  });

  it('accepts optional data field', () => {
    const msg = { ...validJobStatus, data: { exitCode: 0, duration: 12345 } };
    expect(jobStatusSchema.parse(msg)).toEqual(msg);
  });

  it('accepts message without data field', () => {
    expect(jobStatusSchema.parse(validJobStatus)).toEqual(validJobStatus);
  });

  it('rejects invalid state value', () => {
    expect(() => jobStatusSchema.parse({ ...validJobStatus, state: 'unknown' })).toThrow();
  });

  it('round-trips through JSON serialization', () => {
    const roundTripped = JSON.parse(JSON.stringify(validJobStatus));
    expect(jobStatusSchema.parse(roundTripped)).toEqual(validJobStatus);
  });

  it('round-trips with optional data through JSON serialization', () => {
    const msg = { ...validJobStatus, data: { error: 'OOM killed' } };
    const roundTripped = JSON.parse(JSON.stringify(msg));
    expect(jobStatusSchema.parse(roundTripped)).toEqual(msg);
  });

  it('accepts optional secretOutputs with encrypted envelope shape', () => {
    const msg = {
      ...validJobStatus,
      state: 'success',
      secretOutputs: {
        DB_PASSWORD: {
          agentPublicKey: 'MCowBQYDK2VuAyEAagent...',
          encrypted: 'base64encodedIVAuthTagCiphertext...',
        },
        API_KEY: {
          agentPublicKey: 'MCowBQYDK2VuAyEAagent...',
          encrypted: 'anotherEncryptedValue...',
        },
      },
    };
    const parsed = jobStatusSchema.parse(msg);
    expect(parsed.secretOutputs).toBeDefined();
    expect(parsed.secretOutputs!.DB_PASSWORD.agentPublicKey).toBe('MCowBQYDK2VuAyEAagent...');
    expect(parsed.secretOutputs!.DB_PASSWORD.encrypted).toBe('base64encodedIVAuthTagCiphertext...');
    expect(Object.keys(parsed.secretOutputs!)).toHaveLength(2);
  });

  it('parses successfully without secretOutputs (backward compatibility)', () => {
    const parsed = jobStatusSchema.parse(validJobStatus);
    expect(parsed.secretOutputs).toBeUndefined();
  });

  it('rejects secretOutputs with missing agentPublicKey', () => {
    const msg = {
      ...validJobStatus,
      secretOutputs: {
        DB_PASSWORD: { encrypted: 'someValue' },
      },
    };
    expect(() => jobStatusSchema.parse(msg)).toThrow();
  });

  it('rejects secretOutputs with missing encrypted field', () => {
    const msg = {
      ...validJobStatus,
      secretOutputs: {
        DB_PASSWORD: { agentPublicKey: 'someKey' },
      },
    };
    expect(() => jobStatusSchema.parse(msg)).toThrow();
  });

  it('round-trips secretOutputs through JSON serialization', () => {
    const msg = {
      ...validJobStatus,
      state: 'success',
      secretOutputs: {
        TOKEN: {
          agentPublicKey: 'key123',
          encrypted: 'enc456',
        },
      },
    };
    const roundTripped = JSON.parse(JSON.stringify(msg));
    expect(jobStatusSchema.parse(roundTripped)).toEqual(msg);
  });
});

describe('agentLogChunkSchema', () => {
  const validLogChunk = {
    type: 'log.chunk',
    messageId: 'msg-510',
    runId: 'run-001',
    jobId: 'build',
    stepIndex: 0,
    lines: ['$ npm install', 'added 42 packages'],
    timestamp: Date.now(),
  };

  it('validates a well-formed log chunk message', () => {
    expect(agentLogChunkSchema.parse(validLogChunk)).toEqual(validLogChunk);
  });

  it('accepts empty lines array', () => {
    expect(agentLogChunkSchema.parse({ ...validLogChunk, lines: [] })).toBeDefined();
  });

  it('rejects missing jobId', () => {
    const { jobId, ...rest } = validLogChunk;
    expect(() => agentLogChunkSchema.parse(rest)).toThrow();
  });

  it('rejects missing stepIndex', () => {
    const { stepIndex, ...rest } = validLogChunk;
    expect(() => agentLogChunkSchema.parse(rest)).toThrow();
  });

  it('round-trips through JSON serialization', () => {
    const roundTripped = JSON.parse(JSON.stringify(validLogChunk));
    expect(agentLogChunkSchema.parse(roundTripped)).toEqual(validLogChunk);
  });
});

describe('agentStepStatusSchema', () => {
  const validStepStatus = {
    type: 'step.status',
    messageId: 'msg-520',
    runId: 'run-001',
    jobId: 'build',
    stepIndex: 0,
    stepName: 'Install dependencies',
    state: 'running',
    timestamp: Date.now(),
  };

  it('validates a well-formed step status message', () => {
    expect(agentStepStatusSchema.parse(validStepStatus)).toEqual(validStepStatus);
  });

  it('validates all valid state values', () => {
    const states = ['running', 'success', 'failed', 'skipped'];
    for (const state of states) {
      expect(agentStepStatusSchema.parse({ ...validStepStatus, state })).toBeDefined();
    }
  });

  it('rejects invalid state value', () => {
    expect(() => agentStepStatusSchema.parse({ ...validStepStatus, state: 'pending' })).toThrow();
  });

  it('rejects job-level states not applicable to steps', () => {
    expect(() => agentStepStatusSchema.parse({ ...validStepStatus, state: 'queued' })).toThrow();
    expect(() => agentStepStatusSchema.parse({ ...validStepStatus, state: 'cancelled' })).toThrow();
  });

  it('accepts optional data field', () => {
    const msg = { ...validStepStatus, state: 'success', data: { exitCode: 0, duration: 1234 } };
    expect(agentStepStatusSchema.parse(msg)).toEqual(msg);
  });

  it('accepts message without data field', () => {
    expect(agentStepStatusSchema.parse(validStepStatus)).toEqual(validStepStatus);
  });

  it('rejects negative stepIndex', () => {
    expect(() => agentStepStatusSchema.parse({ ...validStepStatus, stepIndex: -1 })).toThrow();
  });

  it('rejects non-integer stepIndex', () => {
    expect(() => agentStepStatusSchema.parse({ ...validStepStatus, stepIndex: 1.5 })).toThrow();
  });

  it('round-trips through JSON serialization', () => {
    const roundTripped = JSON.parse(JSON.stringify(validStepStatus));
    expect(agentStepStatusSchema.parse(roundTripped)).toEqual(validStepStatus);
  });

  it('round-trips with optional data through JSON serialization', () => {
    const msg = { ...validStepStatus, state: 'failed', data: { error: 'ENOENT' } };
    const roundTripped = JSON.parse(JSON.stringify(msg));
    expect(agentStepStatusSchema.parse(roundTripped)).toEqual(msg);
  });

  it('accepts logBytesStreamed when provided as a non-negative integer', () => {
    const msg = { ...validStepStatus, state: 'success', logBytesStreamed: 12345 };
    expect(agentStepStatusSchema.parse(msg)).toEqual(msg);
  });

  it('accepts logBytesStreamed = 0', () => {
    const msg = { ...validStepStatus, state: 'success', logBytesStreamed: 0 };
    expect(agentStepStatusSchema.parse(msg)).toEqual(msg);
  });

  it('rejects negative logBytesStreamed', () => {
    expect(() =>
      agentStepStatusSchema.parse({ ...validStepStatus, state: 'success', logBytesStreamed: -1 }),
    ).toThrow();
  });

  it('rejects non-integer logBytesStreamed', () => {
    expect(() =>
      agentStepStatusSchema.parse({ ...validStepStatus, state: 'success', logBytesStreamed: 1.5 }),
    ).toThrow();
  });
});

describe('registerAckSchema', () => {
  const validAck = {
    type: 'register.ack',
    agentId: 'agent-1',
    labels: ['linux', 'x64'],
    scalerManaged: true,
  };

  it('validates a well-formed register.ack message', () => {
    expect(registerAckSchema.parse(validAck)).toEqual(validAck);
  });

  it('defaults scalerManaged to false when not provided', () => {
    const { scalerManaged, ...rest } = validAck;
    const parsed = registerAckSchema.parse(rest);
    expect(parsed.scalerManaged).toBe(false);
  });

  it('rejects missing agentId', () => {
    const { agentId, ...rest } = validAck;
    expect(() => registerAckSchema.parse(rest)).toThrow();
  });

  it('round-trips through JSON serialization', () => {
    const roundTripped = JSON.parse(JSON.stringify(validAck));
    expect(registerAckSchema.parse(roundTripped)).toEqual(validAck);
  });
});

describe('configAckSchema', () => {
  const validConfigAck = {
    type: 'config.ack',
    messageId: 'msg-800',
    agentId: 'agent-1',
  };

  it('validates a well-formed config.ack message', () => {
    expect(configAckSchema.parse(validConfigAck)).toEqual(validConfigAck);
  });

  it('rejects missing agentId', () => {
    const { agentId, ...rest } = validConfigAck;
    expect(() => configAckSchema.parse(rest)).toThrow();
  });

  it('rejects missing messageId', () => {
    const { messageId, ...rest } = validConfigAck;
    expect(() => configAckSchema.parse(rest)).toThrow();
  });

  it('round-trips through JSON serialization', () => {
    const roundTripped = JSON.parse(JSON.stringify(validConfigAck));
    expect(configAckSchema.parse(roundTripped)).toEqual(validConfigAck);
  });
});

// --- Direction-specific union tests ---

describe('orchestratorToAgentMessageSchema', () => {
  it('accepts job.dispatch messages', () => {
    const msg = {
      type: 'job.dispatch',
      messageId: 'msg-600',
      runId: 'run-1',
      jobId: 'build',
      repoUrl: 'https://github.com/org/repo.git',
      ref: 'refs/heads/main',
      sha: 'abc123',
      lockFileUrl: 'https://s3.example.com/lock.json',
      jobConfig: {},
      timestamp: 123,
    };
    expect(orchestratorToAgentMessageSchema.parse(msg)).toEqual(msg);
  });

  it('accepts job.dispatch with token, secrets, and maxLogSizeBytes', () => {
    const msg = {
      type: 'job.dispatch',
      messageId: 'msg-600',
      runId: 'run-1',
      jobId: 'build',
      repoUrl: 'https://github.com/org/repo.git',
      ref: 'refs/heads/main',
      sha: 'abc123',
      lockFileUrl: 'https://s3.example.com/lock.json',
      jobConfig: {},
      timestamp: 123,
      token: 'ghs_token123',
      secrets: { API_KEY: 'secret' },
      maxLogSizeBytes: 1048576,
    };
    const parsed = orchestratorToAgentMessageSchema.parse(msg);
    expect(parsed).toEqual(msg);
  });

  it('accepts job.cancel messages', () => {
    const msg = {
      type: 'job.cancel',
      messageId: 'msg-601',
      runId: 'run-1',
      jobId: 'build',
      reason: 'timeout',
    };
    expect(orchestratorToAgentMessageSchema.parse(msg)).toEqual(msg);
  });

  it('rejects agent->orchestrator message types (wrong direction)', () => {
    const wrongDirection = {
      type: 'agent.register',
      messageId: 'msg-602',
      agentId: 'agent-1',
      labels: [],
    };
    expect(() => orchestratorToAgentMessageSchema.parse(wrongDirection)).toThrow();
  });

  it('accepts register.ack messages', () => {
    const msg = {
      type: 'register.ack',
      agentId: 'agent-1',
      labels: ['linux'],
      scalerManaged: false,
    };
    expect(orchestratorToAgentMessageSchema.parse(msg)).toEqual(msg);
  });

  it('rejects unknown type discriminator', () => {
    expect(() =>
      orchestratorToAgentMessageSchema.parse({ type: 'unknown', messageId: 'x' }),
    ).toThrow();
  });
});

describe('agentToOrchestratorMessageSchema', () => {
  it('accepts agent.register messages', () => {
    const msg = {
      type: 'agent.register',
      messageId: 'msg-700',
      agentId: 'agent-1',
      labels: ['linux'],
    };
    expect(agentToOrchestratorMessageSchema.parse(msg)).toEqual(msg);
  });

  it('accepts agent.status messages', () => {
    const msg = {
      type: 'agent.status',
      messageId: 'msg-701',
      agentId: 'agent-1',
      activeJobs: 1,
    };
    expect(agentToOrchestratorMessageSchema.parse(msg)).toEqual(msg);
  });

  it('accepts job.status messages', () => {
    const msg = {
      type: 'job.status',
      messageId: 'msg-702',
      runId: 'run-1',
      jobId: 'build',
      state: 'success',
      timestamp: 123,
    };
    expect(agentToOrchestratorMessageSchema.parse(msg)).toEqual(msg);
  });

  it('accepts log.chunk messages', () => {
    const msg = {
      type: 'log.chunk',
      messageId: 'msg-710',
      runId: 'run-1',
      jobId: 'build',
      stepIndex: 0,
      lines: ['output line'],
      timestamp: 123,
    };
    expect(agentToOrchestratorMessageSchema.parse(msg)).toEqual(msg);
  });

  it('accepts step.status messages', () => {
    const msg = {
      type: 'step.status',
      messageId: 'msg-711',
      runId: 'run-1',
      jobId: 'build',
      stepIndex: 0,
      stepName: 'Build',
      state: 'success',
      timestamp: 123,
    };
    expect(agentToOrchestratorMessageSchema.parse(msg)).toEqual(msg);
  });

  it('accepts config.ack messages', () => {
    const msg = {
      type: 'config.ack',
      messageId: 'msg-720',
      agentId: 'agent-1',
    };
    expect(agentToOrchestratorMessageSchema.parse(msg)).toEqual(msg);
  });

  it('rejects orchestrator->agent message types (wrong direction)', () => {
    const wrongDirection = {
      type: 'job.dispatch',
      messageId: 'msg-703',
      runId: 'run-1',
      jobId: 'build',
      repoUrl: 'https://github.com/org/repo.git',
      ref: 'refs/heads/main',
      sha: 'abc123',
      lockFileUrl: 'https://s3.example.com/lock.json',
      jobConfig: {},
      timestamp: 123,
    };
    expect(() => agentToOrchestratorMessageSchema.parse(wrongDirection)).toThrow();
  });

  it('accepts auth.request messages', () => {
    const msg = {
      type: 'auth.request',
      token: 'kat_abc123',
      protocolVersion: 1,
    };
    expect(agentToOrchestratorMessageSchema.parse(msg)).toEqual(msg);
  });
});

// --- Agent auth schema tests ---

describe('agentAuthRequestSchema', () => {
  const validRequest = {
    type: 'auth.request',
    token: 'kat_abc123def456',
    protocolVersion: 1,
  };

  it('validates a well-formed auth request', () => {
    expect(agentAuthRequestSchema.parse(validRequest)).toEqual(validRequest);
  });

  it('rejects empty token', () => {
    expect(() => agentAuthRequestSchema.parse({ ...validRequest, token: '' })).toThrow();
  });

  it('rejects missing token', () => {
    const { token, ...rest } = validRequest;
    expect(() => agentAuthRequestSchema.parse(rest)).toThrow();
  });

  it('rejects missing protocolVersion', () => {
    const { protocolVersion, ...rest } = validRequest;
    expect(() => agentAuthRequestSchema.parse(rest)).toThrow();
  });

  it('rejects non-positive protocolVersion', () => {
    expect(() => agentAuthRequestSchema.parse({ ...validRequest, protocolVersion: 0 })).toThrow();
    expect(() => agentAuthRequestSchema.parse({ ...validRequest, protocolVersion: -1 })).toThrow();
  });

  it('rejects non-integer protocolVersion', () => {
    expect(() => agentAuthRequestSchema.parse({ ...validRequest, protocolVersion: 1.5 })).toThrow();
  });

  it('round-trips through JSON serialization', () => {
    const roundTripped = JSON.parse(JSON.stringify(validRequest));
    expect(agentAuthRequestSchema.parse(roundTripped)).toEqual(validRequest);
  });
});

describe('agentAuthSuccessSchema', () => {
  const validSuccess = {
    type: 'auth.success',
    connectionId: 'conn-agent-001',
  };

  it('validates a well-formed auth success', () => {
    expect(agentAuthSuccessSchema.parse(validSuccess)).toEqual(validSuccess);
  });

  it('rejects missing connectionId', () => {
    const { connectionId, ...rest } = validSuccess;
    expect(() => agentAuthSuccessSchema.parse(rest)).toThrow();
  });

  it('round-trips through JSON serialization', () => {
    const roundTripped = JSON.parse(JSON.stringify(validSuccess));
    expect(agentAuthSuccessSchema.parse(roundTripped)).toEqual(validSuccess);
  });
});

describe('agentAuthFailureSchema', () => {
  const validFailure = {
    type: 'auth.failure',
    reason: 'Invalid or expired token',
  };

  it('validates a well-formed auth failure', () => {
    expect(agentAuthFailureSchema.parse(validFailure)).toEqual(validFailure);
  });

  it('rejects missing reason', () => {
    const { reason, ...rest } = validFailure;
    expect(() => agentAuthFailureSchema.parse(rest)).toThrow();
  });

  it('round-trips through JSON serialization', () => {
    const roundTripped = JSON.parse(JSON.stringify(validFailure));
    expect(agentAuthFailureSchema.parse(roundTripped)).toEqual(validFailure);
  });
});

// --- Metadata field tests ---

describe('agentRegisterSchema metadata fields', () => {
  const baseRegister = {
    type: 'agent.register',
    messageId: 'msg-meta-1',
    agentId: 'agent-meta',
    labels: ['linux', 'x64'],
  };

  it('accepts register message with all metadata fields', () => {
    const msg = {
      ...baseRegister,
      hostname: 'worker-01',
      osRelease: '6.1.0-amd64',
      osVersion: '#1 SMP Debian 6.1.0',
      totalMemoryMb: 16384,
      cpuCount: 8,
      nodeVersion: '24.0.0',
    };
    const parsed = agentRegisterSchema.parse(msg);
    expect(parsed.hostname).toBe('worker-01');
    expect(parsed.osRelease).toBe('6.1.0-amd64');
    expect(parsed.osVersion).toBe('#1 SMP Debian 6.1.0');
    expect(parsed.totalMemoryMb).toBe(16384);
    expect(parsed.cpuCount).toBe(8);
    expect(parsed.nodeVersion).toBe('24.0.0');
  });

  it('accepts register message without metadata fields (backward compat)', () => {
    const parsed = agentRegisterSchema.parse(baseRegister);
    expect(parsed.hostname).toBeUndefined();
    expect(parsed.osRelease).toBeUndefined();
    expect(parsed.osVersion).toBeUndefined();
    expect(parsed.totalMemoryMb).toBeUndefined();
    expect(parsed.cpuCount).toBeUndefined();
    expect(parsed.nodeVersion).toBeUndefined();
  });
});

describe('agentStatusSchema dynamic metadata fields', () => {
  const baseStatus = {
    type: 'agent.status',
    messageId: 'msg-dyn-1',
    agentId: 'agent-dyn',
    activeJobs: 1,
  };

  it('accepts status message with dynamic metadata fields', () => {
    const msg = {
      ...baseStatus,
      memoryUsedMb: 4096,
      memoryAvailableMb: 12288,
      uptimeSeconds: 86400,
    };
    const parsed = agentStatusSchema.parse(msg);
    expect(parsed.memoryUsedMb).toBe(4096);
    expect(parsed.memoryAvailableMb).toBe(12288);
    expect(parsed.uptimeSeconds).toBe(86400);
  });

  it('accepts status message without dynamic metadata (backward compat)', () => {
    const parsed = agentStatusSchema.parse(baseStatus);
    expect(parsed.memoryUsedMb).toBeUndefined();
    expect(parsed.memoryAvailableMb).toBeUndefined();
    expect(parsed.uptimeSeconds).toBeUndefined();
  });
});

describe('agent auth union discrimination', () => {
  it('orchestratorToAgentMessageSchema accepts auth.success', () => {
    const msg = { type: 'auth.success', connectionId: 'conn-1' };
    expect(orchestratorToAgentMessageSchema.parse(msg)).toEqual(msg);
  });

  it('orchestratorToAgentMessageSchema accepts auth.failure', () => {
    const msg = { type: 'auth.failure', reason: 'bad token' };
    expect(orchestratorToAgentMessageSchema.parse(msg)).toEqual(msg);
  });

  it('agentToOrchestratorMessageSchema accepts auth.request', () => {
    const msg = { type: 'auth.request', token: 'kat_test', protocolVersion: 1 };
    expect(agentToOrchestratorMessageSchema.parse(msg)).toEqual(msg);
  });

  it('orchestratorToAgentMessageSchema rejects auth.request (wrong direction)', () => {
    const msg = { type: 'auth.request', token: 'kat_test', protocolVersion: 1 };
    expect(() => orchestratorToAgentMessageSchema.parse(msg)).toThrow();
  });

  it('agentToOrchestratorMessageSchema rejects auth.success (wrong direction)', () => {
    const msg = { type: 'auth.success', connectionId: 'conn-1' };
    expect(() => agentToOrchestratorMessageSchema.parse(msg)).toThrow();
  });

  it('agentToOrchestratorMessageSchema rejects auth.failure (wrong direction)', () => {
    const msg = { type: 'auth.failure', reason: 'bad token' };
    expect(() => agentToOrchestratorMessageSchema.parse(msg)).toThrow();
  });
});

// --- Event emit protocol tests ---

describe('eventEmitSchema', () => {
  const validEmit = {
    type: 'event.emit',
    jobId: 'job-001',
    requestId: 'req-123',
    eventName: 'deploy-complete',
    payload: { env: 'prod', version: '1.2.3' },
  };

  it('validates a well-formed event.emit message', () => {
    expect(eventEmitSchema.parse(validEmit)).toEqual(validEmit);
  });

  it('accepts optional target with repos', () => {
    const msg = { ...validEmit, target: { repos: ['org/other-repo'] } };
    const parsed = eventEmitSchema.parse(msg);
    expect(parsed.target?.repos).toEqual(['org/other-repo']);
  });

  it('accepts message without target', () => {
    const parsed = eventEmitSchema.parse(validEmit);
    expect(parsed.target).toBeUndefined();
  });

  it('accepts empty payload object', () => {
    const msg = { ...validEmit, payload: {} };
    expect(eventEmitSchema.parse(msg)).toEqual(msg);
  });

  it('rejects missing eventName', () => {
    const { eventName, ...rest } = validEmit;
    expect(() => eventEmitSchema.parse(rest)).toThrow();
  });

  it('rejects missing requestId', () => {
    const { requestId, ...rest } = validEmit;
    expect(() => eventEmitSchema.parse(rest)).toThrow();
  });

  it('rejects missing jobId', () => {
    const { jobId, ...rest } = validEmit;
    expect(() => eventEmitSchema.parse(rest)).toThrow();
  });

  it('round-trips through JSON serialization', () => {
    const roundTripped = JSON.parse(JSON.stringify(validEmit));
    expect(eventEmitSchema.parse(roundTripped)).toEqual(validEmit);
  });
});

describe('eventEmitResponseSchema', () => {
  const validResponse = {
    type: 'event.emit.response',
    requestId: 'req-123',
    deliveryId: 'del-456',
  };

  it('validates a successful response with deliveryId', () => {
    expect(eventEmitResponseSchema.parse(validResponse)).toEqual(validResponse);
  });

  it('validates an error response', () => {
    const errorResponse = {
      type: 'event.emit.response',
      requestId: 'req-123',
      error: 'Circuit breaker open',
    };
    const parsed = eventEmitResponseSchema.parse(errorResponse);
    expect(parsed.error).toBe('Circuit breaker open');
    expect(parsed.deliveryId).toBeUndefined();
  });

  it('rejects missing requestId', () => {
    expect(() =>
      eventEmitResponseSchema.parse({ type: 'event.emit.response', deliveryId: 'del-1' }),
    ).toThrow();
  });

  it('round-trips through JSON serialization', () => {
    const roundTripped = JSON.parse(JSON.stringify(validResponse));
    expect(eventEmitResponseSchema.parse(roundTripped)).toEqual(validResponse);
  });
});

// --- Cancellation and concurrency protocol tests ---

describe('jobCancelSchema force flag', () => {
  const validCancel = {
    type: 'job.cancel',
    messageId: 'msg-401',
    runId: 'run-001',
    jobId: 'build',
    reason: 'user requested',
  };

  it('accepts force: true', () => {
    const msg = { ...validCancel, force: true };
    const parsed = jobCancelSchema.parse(msg);
    expect(parsed.force).toBe(true);
  });

  it('accepts force: false', () => {
    const msg = { ...validCancel, force: false };
    const parsed = jobCancelSchema.parse(msg);
    expect(parsed.force).toBe(false);
  });

  it('accepts without force (optional, backward compat)', () => {
    const parsed = jobCancelSchema.parse(validCancel);
    expect(parsed.force).toBeUndefined();
  });
});

describe('jobConcurrencyReportSchema', () => {
  it('parses valid concurrency report message', () => {
    const msg = {
      type: 'job.concurrency.report',
      messageId: 'msg-900',
      runId: 'run-001',
      jobId: 'deploy',
      group: 'production',
    };
    const parsed = jobConcurrencyReportSchema.parse(msg);
    expect(parsed.type).toBe('job.concurrency.report');
    expect(parsed.group).toBe('production');
  });

  it('rejects missing group', () => {
    const msg = {
      type: 'job.concurrency.report',
      messageId: 'msg-900',
      runId: 'run-001',
      jobId: 'deploy',
    };
    expect(() => jobConcurrencyReportSchema.parse(msg)).toThrow();
  });
});

describe('jobConcurrencyAckSchema', () => {
  it('parses valid ack with proceed action', () => {
    const msg = {
      type: 'job.concurrency.ack',
      requestId: 'msg-900',
      action: 'proceed',
    };
    const parsed = jobConcurrencyAckSchema.parse(msg);
    expect(parsed.action).toBe('proceed');
    expect(parsed.reason).toBeUndefined();
  });

  it('parses valid ack with wait action', () => {
    const msg = {
      type: 'job.concurrency.ack',
      requestId: 'msg-900',
      action: 'wait',
      reason: 'slot unavailable',
    };
    const parsed = jobConcurrencyAckSchema.parse(msg);
    expect(parsed.action).toBe('wait');
    expect(parsed.reason).toBe('slot unavailable');
  });

  it('parses valid ack with cancel action', () => {
    const msg = {
      type: 'job.concurrency.ack',
      requestId: 'msg-900',
      action: 'cancel',
      reason: 'concurrency limit reached',
    };
    const parsed = jobConcurrencyAckSchema.parse(msg);
    expect(parsed.action).toBe('cancel');
  });

  it('rejects invalid action', () => {
    const msg = {
      type: 'job.concurrency.ack',
      requestId: 'msg-900',
      action: 'invalid',
    };
    expect(() => jobConcurrencyAckSchema.parse(msg)).toThrow();
  });
});

describe('jobRejectSchema', () => {
  it('parses a busy rejection', () => {
    const msg = {
      type: 'job.reject',
      messageId: 'msg-1',
      runId: 'run-1',
      jobId: 'job-1',
      reason: 'busy',
      timestamp: 1717500000000,
    };
    const parsed = agentToOrchestratorMessageSchema.safeParse(msg);
    expect(parsed.success).toBe(true);
    if (parsed.success && parsed.data.type === 'job.reject') {
      expect(parsed.data.reason).toBe(JobRejectReason.enum.busy);
    }
  });

  it('rejects an unknown reason', () => {
    const parsed = jobRejectSchema.safeParse({
      type: 'job.reject',
      messageId: 'msg-1',
      runId: 'run-1',
      jobId: 'job-1',
      reason: 'tired',
      timestamp: 1717500000000,
    });
    expect(parsed.success).toBe(false);
  });
});

describe('jobStatusSchema cancelling state', () => {
  it('accepts cancelling as a valid state', () => {
    const msg = {
      type: 'job.status',
      messageId: 'msg-502',
      runId: 'run-001',
      jobId: 'build',
      state: 'cancelling',
      timestamp: Date.now(),
    };
    expect(jobStatusSchema.parse(msg)).toBeDefined();
  });
});

describe('agentStepStatusSchema step_type field', () => {
  const baseMsg = {
    type: 'step.status',
    messageId: 'msg-520',
    runId: 'run-001',
    jobId: 'build',
    stepIndex: 0,
    stepName: 'Build',
    state: 'running',
    timestamp: Date.now(),
  };

  it('accepts default step type', () => {
    const parsed = agentStepStatusSchema.parse({ ...baseMsg, step_type: 'step' });
    expect(parsed.step_type).toBe('step');
  });

  it('accepts hook:onCancel step type', () => {
    const parsed = agentStepStatusSchema.parse({ ...baseMsg, step_type: 'hook:onCancel' });
    expect(parsed.step_type).toBe('hook:onCancel');
  });

  it('accepts hook:cleanup step type', () => {
    const parsed = agentStepStatusSchema.parse({ ...baseMsg, step_type: 'hook:cleanup' });
    expect(parsed.step_type).toBe('hook:cleanup');
  });

  it('accepts hook:onSuccess step type', () => {
    const parsed = agentStepStatusSchema.parse({ ...baseMsg, step_type: 'hook:onSuccess' });
    expect(parsed.step_type).toBe('hook:onSuccess');
  });

  it('accepts hook:onFailure step type', () => {
    const parsed = agentStepStatusSchema.parse({ ...baseMsg, step_type: 'hook:onFailure' });
    expect(parsed.step_type).toBe('hook:onFailure');
  });

  it('accepts hook:beforeStep step type', () => {
    const parsed = agentStepStatusSchema.parse({ ...baseMsg, step_type: 'hook:beforeStep' });
    expect(parsed.step_type).toBe('hook:beforeStep');
  });

  it('accepts hook:afterStep step type', () => {
    const parsed = agentStepStatusSchema.parse({ ...baseMsg, step_type: 'hook:afterStep' });
    expect(parsed.step_type).toBe('hook:afterStep');
  });

  it('accepts without step_type (optional, backward compat)', () => {
    const parsed = agentStepStatusSchema.parse(baseMsg);
    expect(parsed.step_type).toBeUndefined();
  });
});

describe('concurrency union discrimination', () => {
  it('agentToOrchestratorMessageSchema accepts job.concurrency.report', () => {
    const msg = {
      type: 'job.concurrency.report',
      messageId: 'msg-900',
      runId: 'run-001',
      jobId: 'deploy',
      group: 'production',
    };
    expect(agentToOrchestratorMessageSchema.parse(msg)).toEqual(msg);
  });

  it('orchestratorToAgentMessageSchema accepts job.concurrency.ack', () => {
    const msg = {
      type: 'job.concurrency.ack',
      requestId: 'msg-900',
      action: 'proceed',
    };
    expect(orchestratorToAgentMessageSchema.parse(msg)).toEqual(msg);
  });
});

describe('event.emit union discrimination', () => {
  it('agentToOrchestratorMessageSchema accepts event.emit', () => {
    const msg = {
      type: 'event.emit',
      jobId: 'job-001',
      requestId: 'req-123',
      eventName: 'deploy-complete',
      payload: { env: 'prod' },
    };
    expect(agentToOrchestratorMessageSchema.parse(msg)).toEqual(msg);
  });

  it('orchestratorToAgentMessageSchema accepts event.emit.response', () => {
    const msg = {
      type: 'event.emit.response',
      requestId: 'req-123',
      deliveryId: 'del-456',
    };
    expect(orchestratorToAgentMessageSchema.parse(msg)).toEqual(msg);
  });

  it('orchestratorToAgentMessageSchema rejects event.emit (wrong direction)', () => {
    const msg = {
      type: 'event.emit',
      jobId: 'job-001',
      requestId: 'req-123',
      eventName: 'test',
      payload: {},
    };
    expect(() => orchestratorToAgentMessageSchema.parse(msg)).toThrow();
  });

  it('agentToOrchestratorMessageSchema rejects event.emit.response (wrong direction)', () => {
    const msg = {
      type: 'event.emit.response',
      requestId: 'req-123',
      deliveryId: 'del-456',
    };
    expect(() => agentToOrchestratorMessageSchema.parse(msg)).toThrow();
  });
});

describe('jobAckSchema', () => {
  it('accepts a valid job.ack and routes through the agent->orchestrator union', () => {
    const msg = {
      type: 'job.ack',
      messageId: 'm-1',
      runId: 'run-1',
      jobId: 'job-1',
      timestamp: 1717689600000,
    };
    expect(jobAckSchema.parse(msg)).toEqual(msg);
    const viaUnion = agentToOrchestratorMessageSchema.parse(msg);
    expect(viaUnion.type).toBe('job.ack');
  });

  it('rejects a job.ack missing jobId', () => {
    expect(() =>
      jobAckSchema.parse({ type: 'job.ack', messageId: 'm-1', runId: 'run-1', timestamp: 1 }),
    ).toThrow();
  });
});

describe('step approval round-trip', () => {
  const base = {
    type: 'step.approval-request' as const,
    messageId: 'm-1',
    runId: 'run-1',
    jobId: 'deploy',
    stepIndex: 2,
    stepName: 'apply',
    clauses: [{ team: 'leads' }, { user: 'u-cto' }],
    reason: 'deploy gate',
  };

  it('step.approval-request parses and routes through the agent->orchestrator union', () => {
    const msg = { ...base, timeoutSeconds: 1800 };
    expect(stepApprovalRequestSchema.parse(msg)).toEqual(msg);
    const viaUnion = agentToOrchestratorMessageSchema.parse(msg);
    expect(viaUnion.type).toBe('step.approval-request');
  });

  it('step.approval-request accepts an empty-clause requirement without a timeout', () => {
    const msg = { ...base, clauses: [] };
    expect(stepApprovalRequestSchema.parse(msg)).toEqual(msg);
  });

  it('step.approval-request rejects a negative stepIndex', () => {
    expect(() => stepApprovalRequestSchema.parse({ ...base, stepIndex: -1 })).toThrow();
  });

  it('step.approval-resolved parses each outcome and routes through the orch->agent union', () => {
    for (const outcome of StepApprovalOutcome.options) {
      const msg = {
        type: 'step.approval-resolved' as const,
        requestId: 'm-1',
        runId: 'run-1',
        jobId: 'deploy',
        stepIndex: 2,
        outcome,
      };
      expect(stepApprovalResolvedSchema.parse(msg)).toEqual(msg);
      const viaUnion = orchestratorToAgentMessageSchema.parse(msg);
      expect(viaUnion.type).toBe('step.approval-resolved');
    }
  });

  it('step.approval-resolved rejects an unknown outcome', () => {
    expect(() =>
      stepApprovalResolvedSchema.parse({
        type: 'step.approval-resolved',
        requestId: 'm-1',
        runId: 'run-1',
        jobId: 'deploy',
        stepIndex: 2,
        outcome: 'maybe',
      }),
    ).toThrow();
  });
});

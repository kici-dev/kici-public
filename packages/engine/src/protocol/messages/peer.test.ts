import { describe, expect, it } from 'vitest';
import {
  peerHelloSchema,
  peerHelloResponseSchema,
  peerAuthRequestSchema,
  peerAuthResponseSchema,
  peerHeartbeatSchema,
  jobRerouteSchema,
  jobRerouteAckSchema,
  jobProgressSchema,
  peerScalerEventSchema,
  peerJobCancelSchema,
  raftVoteRequestSchema,
  raftVoteResponseSchema,
  raftAppendEntriesSchema,
  peerLeavingSchema,
  peerAgentTokenRevokeSchema,
  peerToPeerMessageSchema,
  peerFromPeerMessageSchema,
} from './peer.js';
import { ScalerEventType } from './scaler-event.js';

// --- Individual schema tests ---

describe('peerHelloSchema', () => {
  const valid = {
    type: 'peer.hello',
    ephemeralPublicKey: 'base64-public-key-data',
    nonce: 'base64-nonce-data',
  };

  it('validates a well-formed hello', () => {
    expect(peerHelloSchema.parse(valid)).toEqual(valid);
  });

  it('rejects missing ephemeralPublicKey', () => {
    const { ephemeralPublicKey, ...rest } = valid;
    expect(() => peerHelloSchema.parse(rest)).toThrow();
  });

  it('rejects missing nonce', () => {
    const { nonce, ...rest } = valid;
    expect(() => peerHelloSchema.parse(rest)).toThrow();
  });

  it('round-trips through JSON serialization', () => {
    const roundTripped = JSON.parse(JSON.stringify(valid));
    expect(peerHelloSchema.parse(roundTripped)).toEqual(valid);
  });
});

describe('peerHelloResponseSchema', () => {
  const valid = {
    type: 'peer.hello.response',
    ephemeralPublicKey: 'base64-public-key-data',
  };

  it('validates a well-formed hello response', () => {
    expect(peerHelloResponseSchema.parse(valid)).toEqual(valid);
  });

  it('rejects missing ephemeralPublicKey', () => {
    const { ephemeralPublicKey, ...rest } = valid;
    expect(() => peerHelloResponseSchema.parse(rest)).toThrow();
  });

  it('round-trips through JSON serialization', () => {
    const roundTripped = JSON.parse(JSON.stringify(valid));
    expect(peerHelloResponseSchema.parse(roundTripped)).toEqual(valid);
  });
});

describe('peerAuthRequestSchema', () => {
  const valid = {
    type: 'peer.auth.request',
    instanceId: 'orch-1',
    token: 'kici_join_v1.routing.secret',
    protocolVersion: 1,
  };

  it('validates a well-formed auth request with token', () => {
    expect(peerAuthRequestSchema.parse(valid)).toEqual(valid);
  });

  it('validates auth request with proof instead of token', () => {
    const msg = {
      type: 'peer.auth.request',
      instanceId: 'orch-1',
      proof: 'hmac-proof',
      protocolVersion: 1,
    };
    expect(peerAuthRequestSchema.parse(msg)).toEqual(msg);
  });

  it('validates auth request with both token and proof omitted', () => {
    const msg = { type: 'peer.auth.request', instanceId: 'orch-1', protocolVersion: 1 };
    expect(peerAuthRequestSchema.parse(msg)).toEqual(msg);
  });

  it('rejects missing instanceId', () => {
    const { instanceId, ...rest } = valid;
    expect(() => peerAuthRequestSchema.parse(rest)).toThrow();
  });

  it('round-trips through JSON serialization', () => {
    const roundTripped = JSON.parse(JSON.stringify(valid));
    expect(peerAuthRequestSchema.parse(roundTripped)).toEqual(valid);
  });
});

describe('peerAuthResponseSchema', () => {
  const valid = {
    type: 'peer.auth.response',
    accepted: true,
    instanceId: 'orch-2',
  };

  it('validates a well-formed auth response', () => {
    expect(peerAuthResponseSchema.parse(valid)).toEqual(valid);
  });

  it('accepts optional reason on rejection', () => {
    const msg = { ...valid, accepted: false, reason: 'Invalid token' };
    expect(peerAuthResponseSchema.parse(msg)).toEqual(msg);
  });

  it('accepts response without instanceId (optional)', () => {
    const msg = { type: 'peer.auth.response', accepted: true };
    const parsed = peerAuthResponseSchema.parse(msg);
    expect(parsed.instanceId).toBeUndefined();
  });

  it('accepts sessionCredential on first join', () => {
    const msg = { ...valid, sessionCredential: 'cred-base64', role: 'worker' };
    const parsed = peerAuthResponseSchema.parse(msg);
    expect(parsed.sessionCredential).toBe('cred-base64');
    expect(parsed.role).toBe('worker');
  });

  it('rejects missing accepted field', () => {
    const { accepted, ...rest } = valid;
    expect(() => peerAuthResponseSchema.parse(rest)).toThrow();
  });

  it('round-trips through JSON serialization', () => {
    const roundTripped = JSON.parse(JSON.stringify(valid));
    expect(peerAuthResponseSchema.parse(roundTripped)).toEqual(valid);
  });
});

describe('peerHeartbeatSchema', () => {
  const valid = {
    type: 'peer.heartbeat',
    instanceId: 'orch-1',
    term: 3,
    leaderId: 'orch-2',
    draining: false,
    agents: [
      {
        agentId: 'agent-1',
        labels: ['linux', 'x64'],
        activeJobs: 1,
        maxConcurrency: 4,
        platform: 'linux',
        arch: 'x64',
        // Static agent: no scaler-side gate.
        mandatoryLabels: [],
      },
    ],
    capabilities: {
      s3LogAccess: true,
      logRoutingOverride: 'direct' as const,
    },
    timestamp: Date.now(),
  };

  it('validates a well-formed heartbeat', () => {
    expect(peerHeartbeatSchema.parse(valid)).toEqual(valid);
  });

  it('accepts null leaderId (no leader elected)', () => {
    const msg = { ...valid, leaderId: null };
    expect(peerHeartbeatSchema.parse(msg)).toEqual(msg);
  });

  it('accepts empty agents array', () => {
    const msg = { ...valid, agents: [] };
    expect(peerHeartbeatSchema.parse(msg)).toEqual(msg);
  });

  it('accepts capabilities without logRoutingOverride', () => {
    const msg = { ...valid, capabilities: { s3LogAccess: false } };
    const parsed = peerHeartbeatSchema.parse(msg);
    expect(parsed.capabilities.logRoutingOverride).toBeUndefined();
  });

  it('validates logRoutingOverride enum values', () => {
    for (const override of ['direct', 'coordinator']) {
      const msg = { ...valid, capabilities: { s3LogAccess: true, logRoutingOverride: override } };
      expect(peerHeartbeatSchema.parse(msg)).toBeDefined();
    }
  });

  it('rejects invalid logRoutingOverride', () => {
    const msg = {
      ...valid,
      capabilities: { s3LogAccess: true, logRoutingOverride: 'invalid' },
    };
    expect(() => peerHeartbeatSchema.parse(msg)).toThrow();
  });

  it('rejects missing agents field', () => {
    const { agents, ...rest } = valid;
    expect(() => peerHeartbeatSchema.parse(rest)).toThrow();
  });

  it('rejects missing capabilities field', () => {
    const { capabilities, ...rest } = valid;
    expect(() => peerHeartbeatSchema.parse(rest)).toThrow();
  });

  it('round-trips through JSON serialization', () => {
    const roundTripped = JSON.parse(JSON.stringify(valid));
    expect(peerHeartbeatSchema.parse(roundTripped)).toEqual(valid);
  });

  it('accepts heartbeat with scalerCapacity field', () => {
    const msg = {
      ...valid,
      scalerCapacity: [
        {
          labelSets: [
            ['linux', 'x64'],
            ['linux', 'arm64'],
          ],
          maxAgents: 10,
          activeCount: 3,
        },
        {
          labelSets: [['linux', 'gpu']],
          maxAgents: 4,
          activeCount: 0,
        },
      ],
    };
    const parsed = peerHeartbeatSchema.parse(msg);
    expect(parsed.scalerCapacity).toHaveLength(2);
    expect(parsed.scalerCapacity![0].labelSets).toEqual([
      ['linux', 'x64'],
      ['linux', 'arm64'],
    ]);
    expect(parsed.scalerCapacity![0].maxAgents).toBe(10);
    expect(parsed.scalerCapacity![0].activeCount).toBe(3);
    expect(parsed.scalerCapacity![1].labelSets).toEqual([['linux', 'gpu']]);
  });

  it('accepts heartbeat without scalerCapacity (backward compatibility)', () => {
    const parsed = peerHeartbeatSchema.parse(valid);
    expect(parsed.scalerCapacity).toBeUndefined();
  });

  it('accepts heartbeat with scalerCapacity carrying mandatoryLabels', () => {
    const msg = {
      ...valid,
      scalerCapacity: [
        {
          name: 'gpu-pool',
          type: 'container',
          labelSets: [['linux', 'gpu']],
          maxAgents: 5,
          activeCount: 1,
          mandatoryLabels: ['gpu'],
        },
      ],
    };
    const parsed = peerHeartbeatSchema.parse(msg);
    expect(parsed.scalerCapacity![0].mandatoryLabels).toEqual(['gpu']);
  });

  it('defaults mandatoryLabels to [] when omitted on a scalerCapacity entry (legacy peer)', () => {
    const msg = {
      ...valid,
      scalerCapacity: [
        {
          labelSets: [['linux', 'x64']],
          maxAgents: 5,
          activeCount: 1,
          // mandatoryLabels intentionally omitted
        },
      ],
    };
    const parsed = peerHeartbeatSchema.parse(msg);
    expect(parsed.scalerCapacity![0].mandatoryLabels).toEqual([]);
  });
});

describe('jobRerouteSchema', () => {
  const valid = {
    type: 'job.reroute',
    messageId: 'msg-rr-1',
    jobId: 'job-rr-1',
    runId: 'run-001',
    deliveryId: 'del-abc',
    routingKey: 'github:42',
    event: 'push',
    action: null,
    payload: { ref: 'refs/heads/main' },
    jobName: 'test',
    workflowName: 'ci',
    runsOnLabels: [['linux', 'arm64']],
    triedConnections: ['conn-1'],
    maxHops: 3,
    coordinatorId: 'orch-1',
  };

  it('validates a well-formed reroute', () => {
    expect(jobRerouteSchema.parse(valid)).toEqual(valid);
  });

  it('accepts optional requestId and traceId', () => {
    const msg = { ...valid, requestId: 'req-123', traceId: 'trace-456' };
    const parsed = jobRerouteSchema.parse(msg);
    expect(parsed.requestId).toBe('req-123');
    expect(parsed.traceId).toBe('trace-456');
  });

  it('accepts multiple runsOnLabels groups', () => {
    const msg = {
      ...valid,
      runsOnLabels: [
        ['linux', 'x64'],
        ['linux', 'arm64'],
      ],
    };
    expect(jobRerouteSchema.parse(msg)).toEqual(msg);
  });

  it('accepts empty triedConnections', () => {
    const msg = { ...valid, triedConnections: [] };
    expect(jobRerouteSchema.parse(msg)).toEqual(msg);
  });

  it('rejects missing coordinatorId', () => {
    const { coordinatorId, ...rest } = valid;
    expect(() => jobRerouteSchema.parse(rest)).toThrow();
  });

  it('rejects missing jobName', () => {
    const { jobName, ...rest } = valid;
    expect(() => jobRerouteSchema.parse(rest)).toThrow();
  });

  it('round-trips through JSON serialization', () => {
    const roundTripped = JSON.parse(JSON.stringify(valid));
    expect(jobRerouteSchema.parse(roundTripped)).toEqual(valid);
  });
});

describe('jobRerouteAckSchema', () => {
  const valid = {
    type: 'job.reroute.ack',
    messageId: 'msg-rr-1',
    accepted: true,
  };

  it('validates a well-formed ack', () => {
    expect(jobRerouteAckSchema.parse(valid)).toEqual(valid);
  });

  it('accepts rejection with reason', () => {
    const msg = { ...valid, accepted: false, reason: 'No matching agent' };
    expect(jobRerouteAckSchema.parse(msg)).toEqual(msg);
  });

  it('rejects missing accepted field', () => {
    const { accepted, ...rest } = valid;
    expect(() => jobRerouteAckSchema.parse(rest)).toThrow();
  });

  it('round-trips through JSON serialization', () => {
    const roundTripped = JSON.parse(JSON.stringify(valid));
    expect(jobRerouteAckSchema.parse(roundTripped)).toEqual(valid);
  });
});

describe('jobProgressSchema', () => {
  const valid = {
    type: 'job.progress',
    kind: 'step' as const,
    runId: 'run-001',
    jobId: 'build-1',
    jobName: 'build',
    stepIndex: 2,
    stepName: 'Run tests',
    state: 'running' as const,
    timestamp: Date.now(),
  };

  it('validates a well-formed progress message', () => {
    expect(jobProgressSchema.parse(valid)).toEqual(valid);
  });

  it('validates step-level state values', () => {
    for (const state of ['running', 'success', 'failed', 'skipped']) {
      expect(jobProgressSchema.parse({ ...valid, state })).toBeDefined();
    }
  });

  it('validates job-level kind with full job state space', () => {
    for (const state of ['running', 'success', 'failed', 'skipped', 'cancelled']) {
      expect(jobProgressSchema.parse({ ...valid, kind: 'job', state })).toBeDefined();
    }
  });

  it('rejects an unknown state', () => {
    expect(() => jobProgressSchema.parse({ ...valid, state: 'banana' })).toThrow();
  });

  it('rejects an unknown kind', () => {
    expect(() => jobProgressSchema.parse({ ...valid, kind: 'workflow' })).toThrow();
  });

  it('rejects a missing kind', () => {
    const { kind: _kind, ...rest } = valid;
    expect(() => jobProgressSchema.parse(rest)).toThrow();
  });

  it('accepts optional data field', () => {
    const msg = { ...valid, data: { exitCode: 0 } };
    expect(jobProgressSchema.parse(msg)).toEqual(msg);
  });

  it('round-trips through JSON serialization', () => {
    const roundTripped = JSON.parse(JSON.stringify(valid));
    expect(jobProgressSchema.parse(roundTripped)).toEqual(valid);
  });
});

describe('peerScalerEventSchema', () => {
  const valid = {
    type: 'scaler.event',
    runId: 'run-001',
    jobId: 'build-1',
    agentId: 'scaler-container-abc',
    eventType: ScalerEventType.enum['scaler.failed'],
    detail: 'image pull failed: not found',
    timestampMs: 1700000000000,
  };

  it('validates a well-formed scaler event message', () => {
    expect(peerScalerEventSchema.parse(valid)).toEqual(valid);
  });

  it('rejects a missing runId', () => {
    const { runId: _runId, ...rest } = valid;
    expect(() => peerScalerEventSchema.parse(rest)).toThrow();
  });

  it('rejects a non-numeric timestampMs', () => {
    expect(() => peerScalerEventSchema.parse({ ...valid, timestampMs: 'soon' })).toThrow();
  });

  it('rejects an eventType outside the ScalerEventType enum', () => {
    expect(() => peerScalerEventSchema.parse({ ...valid, eventType: 'scaler.bogus' })).toThrow();
  });

  it('accepts every ScalerEventType enum member', () => {
    for (const member of ScalerEventType.options) {
      expect(peerScalerEventSchema.parse({ ...valid, eventType: member }).eventType).toBe(member);
    }
  });

  it('round-trips through JSON serialization', () => {
    const roundTripped = JSON.parse(JSON.stringify(valid));
    expect(peerScalerEventSchema.parse(roundTripped)).toEqual(valid);
  });

  it('is accepted by the inbound peer message union', () => {
    expect(peerFromPeerMessageSchema.parse(valid)).toEqual(valid);
  });
});

describe('peerJobCancelSchema', () => {
  const valid = {
    type: 'peer.job.cancel',
    runId: 'run-001',
    reason: 'Superseded by newer push',
  };

  it('validates a well-formed cancel', () => {
    expect(peerJobCancelSchema.parse(valid)).toEqual(valid);
  });

  it('accepts optional jobId for targeted cancel', () => {
    const msg = { ...valid, jobId: 'build-1' };
    expect(peerJobCancelSchema.parse(msg)).toEqual(msg);
  });

  it('accepts cancel without jobId (cancel all jobs in run)', () => {
    const parsed = peerJobCancelSchema.parse(valid);
    expect(parsed.jobId).toBeUndefined();
  });

  it('rejects missing reason', () => {
    const { reason, ...rest } = valid;
    expect(() => peerJobCancelSchema.parse(rest)).toThrow();
  });

  it('round-trips through JSON serialization', () => {
    const roundTripped = JSON.parse(JSON.stringify(valid));
    expect(peerJobCancelSchema.parse(roundTripped)).toEqual(valid);
  });
});

describe('raftVoteRequestSchema', () => {
  const valid = {
    type: 'raft.vote.request',
    term: 5,
    candidateId: 'orch-1',
    lastLogIndex: 10,
    lastLogTerm: 4,
  };

  it('validates a well-formed vote request', () => {
    expect(raftVoteRequestSchema.parse(valid)).toEqual(valid);
  });

  it('rejects missing term', () => {
    const { term, ...rest } = valid;
    expect(() => raftVoteRequestSchema.parse(rest)).toThrow();
  });

  it('rejects missing candidateId', () => {
    const { candidateId, ...rest } = valid;
    expect(() => raftVoteRequestSchema.parse(rest)).toThrow();
  });

  it('round-trips through JSON serialization', () => {
    const roundTripped = JSON.parse(JSON.stringify(valid));
    expect(raftVoteRequestSchema.parse(roundTripped)).toEqual(valid);
  });
});

describe('raftVoteResponseSchema', () => {
  const valid = {
    type: 'raft.vote.response',
    term: 5,
    voteGranted: true,
    voterId: 'orch-2',
  };

  it('validates a well-formed vote response', () => {
    expect(raftVoteResponseSchema.parse(valid)).toEqual(valid);
  });

  it('accepts rejection', () => {
    const msg = { ...valid, voteGranted: false };
    expect(raftVoteResponseSchema.parse(msg)).toEqual(msg);
  });

  it('rejects missing voterId', () => {
    const { voterId, ...rest } = valid;
    expect(() => raftVoteResponseSchema.parse(rest)).toThrow();
  });

  it('round-trips through JSON serialization', () => {
    const roundTripped = JSON.parse(JSON.stringify(valid));
    expect(raftVoteResponseSchema.parse(roundTripped)).toEqual(valid);
  });
});

describe('raftAppendEntriesSchema', () => {
  const valid = {
    type: 'raft.append.entries',
    term: 5,
    leaderId: 'orch-1',
  };

  it('validates a well-formed append entries', () => {
    expect(raftAppendEntriesSchema.parse(valid)).toEqual(valid);
  });

  it('rejects missing leaderId', () => {
    const { leaderId, ...rest } = valid;
    expect(() => raftAppendEntriesSchema.parse(rest)).toThrow();
  });

  it('rejects missing term', () => {
    const { term, ...rest } = valid;
    expect(() => raftAppendEntriesSchema.parse(rest)).toThrow();
  });

  it('round-trips through JSON serialization', () => {
    const roundTripped = JSON.parse(JSON.stringify(valid));
    expect(raftAppendEntriesSchema.parse(roundTripped)).toEqual(valid);
  });
});

describe('peerLeavingSchema', () => {
  const valid = {
    type: 'peer.leaving',
    instanceId: 'orch-1',
    term: 5,
  };

  it('validates a well-formed peer.leaving message', () => {
    expect(peerLeavingSchema.parse(valid)).toEqual(valid);
  });

  it('rejects missing instanceId', () => {
    const { instanceId, ...rest } = valid;
    expect(() => peerLeavingSchema.parse(rest)).toThrow();
  });

  it('rejects missing term', () => {
    const { term, ...rest } = valid;
    expect(() => peerLeavingSchema.parse(rest)).toThrow();
  });

  it('round-trips through JSON serialization', () => {
    const roundTripped = JSON.parse(JSON.stringify(valid));
    expect(peerLeavingSchema.parse(roundTripped)).toEqual(valid);
  });

  it('is included in peerToPeerMessageSchema discriminated union', () => {
    expect(peerToPeerMessageSchema.parse(valid)).toEqual(valid);
  });

  it('is included in peerFromPeerMessageSchema discriminated union', () => {
    expect(peerFromPeerMessageSchema.parse(valid)).toEqual(valid);
  });
});

describe('peerAgentTokenRevokeSchema', () => {
  const valid = {
    type: 'peer.agent-token.revoke',
    tokenId: '6c3f0b3a-9d2e-4a40-8a1c-2d5e8f9a1b2c',
    senderInstanceId: 'orch-a',
  };

  it('validates a well-formed peer.agent-token.revoke message', () => {
    expect(peerAgentTokenRevokeSchema.parse(valid)).toEqual(valid);
  });

  it('rejects missing tokenId', () => {
    const { tokenId, ...rest } = valid;
    expect(() => peerAgentTokenRevokeSchema.parse(rest)).toThrow();
  });

  it('rejects empty tokenId', () => {
    expect(() => peerAgentTokenRevokeSchema.parse({ ...valid, tokenId: '' })).toThrow();
  });

  it('rejects missing senderInstanceId', () => {
    const { senderInstanceId, ...rest } = valid;
    expect(() => peerAgentTokenRevokeSchema.parse(rest)).toThrow();
  });

  it('round-trips through JSON serialization', () => {
    const roundTripped = JSON.parse(JSON.stringify(valid));
    expect(peerAgentTokenRevokeSchema.parse(roundTripped)).toEqual(valid);
  });

  it('is included in peerToPeerMessageSchema discriminated union', () => {
    expect(peerToPeerMessageSchema.parse(valid)).toEqual(valid);
  });

  it('is included in peerFromPeerMessageSchema discriminated union', () => {
    expect(peerFromPeerMessageSchema.parse(valid)).toEqual(valid);
  });
});

// --- Discriminated union tests ---

describe('peerToPeerMessageSchema', () => {
  it('accepts peer.hello', () => {
    const msg = {
      type: 'peer.hello',
      ephemeralPublicKey: 'key-data',
      nonce: 'nonce-data',
    };
    expect(peerToPeerMessageSchema.parse(msg)).toEqual(msg);
  });

  it('accepts peer.hello.response', () => {
    const msg = {
      type: 'peer.hello.response',
      ephemeralPublicKey: 'key-data',
    };
    expect(peerToPeerMessageSchema.parse(msg)).toEqual(msg);
  });

  it('accepts peer.auth.request', () => {
    const msg = {
      type: 'peer.auth.request',
      instanceId: 'orch-1',
      token: 'join-token',
      protocolVersion: 1,
    };
    expect(peerToPeerMessageSchema.parse(msg)).toEqual(msg);
  });

  it('accepts peer.heartbeat', () => {
    const msg = {
      type: 'peer.heartbeat',
      instanceId: 'orch-1',
      term: 1,
      leaderId: null,
      draining: false,
      agents: [],
      capabilities: { s3LogAccess: false },
      timestamp: 123,
    };
    expect(peerToPeerMessageSchema.parse(msg)).toEqual(msg);
  });

  it('accepts job.reroute', () => {
    const msg = {
      type: 'job.reroute',
      messageId: 'msg-1',
      jobId: 'job-1',
      runId: 'run-1',
      deliveryId: 'del-1',
      routingKey: 'github:42',
      event: 'push',
      action: null,
      payload: {},
      jobName: 'test',
      workflowName: 'ci',
      runsOnLabels: [['linux']],
      triedConnections: [],
      maxHops: 3,
      coordinatorId: 'orch-1',
    };
    expect(peerToPeerMessageSchema.parse(msg)).toEqual(msg);
  });

  it('accepts raft.vote.request', () => {
    const msg = {
      type: 'raft.vote.request',
      term: 1,
      candidateId: 'orch-1',
      lastLogIndex: 0,
      lastLogTerm: 0,
    };
    expect(peerToPeerMessageSchema.parse(msg)).toEqual(msg);
  });

  it('accepts raft.append.entries', () => {
    const msg = {
      type: 'raft.append.entries',
      term: 1,
      leaderId: 'orch-1',
    };
    expect(peerToPeerMessageSchema.parse(msg)).toEqual(msg);
  });

  it('rejects unknown type discriminator', () => {
    expect(() => peerToPeerMessageSchema.parse({ type: 'unknown', data: 'x' })).toThrow();
  });

  it('rejects non-peer message types', () => {
    expect(() =>
      peerToPeerMessageSchema.parse({
        type: 'webhook.relay',
        messageId: 'msg-1',
        routingKey: 'github:1',
        deliveryId: 'del-1',
        event: 'push',
        payload: {},
      }),
    ).toThrow();
  });
});

describe('peerFromPeerMessageSchema', () => {
  it('accepts peer.auth.response', () => {
    const msg = {
      type: 'peer.auth.response',
      accepted: true,
      instanceId: 'orch-2',
    };
    expect(peerFromPeerMessageSchema.parse(msg)).toEqual(msg);
  });

  it('accepts job.reroute.ack', () => {
    const msg = {
      type: 'job.reroute.ack',
      messageId: 'msg-1',
      accepted: true,
    };
    expect(peerFromPeerMessageSchema.parse(msg)).toEqual(msg);
  });

  it('accepts job.progress', () => {
    const msg = {
      type: 'job.progress',
      kind: 'step',
      runId: 'run-1',
      jobId: 'build',
      jobName: 'build',
      stepIndex: 0,
      stepName: 'Install',
      state: 'success',
      timestamp: 123,
    };
    expect(peerFromPeerMessageSchema.parse(msg)).toEqual(msg);
  });

  it('accepts peer.job.cancel', () => {
    const msg = {
      type: 'peer.job.cancel',
      runId: 'run-1',
      reason: 'Cancelled by user',
    };
    expect(peerFromPeerMessageSchema.parse(msg)).toEqual(msg);
  });

  it('accepts raft.vote.response', () => {
    const msg = {
      type: 'raft.vote.response',
      term: 1,
      voteGranted: true,
      voterId: 'orch-2',
    };
    expect(peerFromPeerMessageSchema.parse(msg)).toEqual(msg);
  });

  it('rejects unknown type discriminator', () => {
    expect(() => peerFromPeerMessageSchema.parse({ type: 'unknown', data: 'x' })).toThrow();
  });
});

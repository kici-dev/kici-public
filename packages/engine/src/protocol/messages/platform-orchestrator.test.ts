import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  webhookRelaySchema,
  webhookRelayStartSchema,
  webhookRelayChunkSchema,
  webhookAckSchema,
  WebhookRelayResult,
  WEBHOOK_RELAY_MAX_BODY_BYTES,
  executionEventSchema,
  logChunkSchema,
  peerDiscoverSchema,
  peerUpdateSchema,
  cacheStatsSchema,
  platformToOrchestratorMessageSchema,
  orchestratorToPlatformMessageSchema,
  trustPolicyUpdateSchema,
} from './platform-orchestrator.js';
import { sourceRegistrationSchema, sourceRegistrationAckSchema } from './source-registration.js';
import { logPullPlatformToOrchSchema } from './log-pull.js';
import { dashboardPlatformToOrchSchema } from './dashboard.js';
import { joinRequestSchema } from './join.js';

// --- Individual schema tests ---

describe('trustPolicyUpdateSchema', () => {
  const base = {
    type: 'trust_policy.update' as const,
    orgId: 'org-1',
    policy: {
      forkPolicy: 'hold' as const,
      unknownContributorPolicy: 'hold' as const,
      workflowChangePolicy: 'hold' as const,
      approvalExpiryHours: 24,
    },
    identityLinks: [],
    memberCiTrustLevels: {},
  };

  it('round-trips teamMemberships', () => {
    const parsed = trustPolicyUpdateSchema.parse({
      ...base,
      teamMemberships: [
        { teamName: 'leads', memberUserIds: ['u-1', 'u-2'] },
        { teamName: 'sec', memberUserIds: [] },
      ],
    });
    expect(parsed.teamMemberships).toEqual([
      { teamName: 'leads', memberUserIds: ['u-1', 'u-2'] },
      { teamName: 'sec', memberUserIds: [] },
    ]);
  });

  it('defaults teamMemberships to [] when omitted', () => {
    const parsed = trustPolicyUpdateSchema.parse(base);
    expect(parsed.teamMemberships).toEqual([]);
  });
});

describe('webhookRelaySchema', () => {
  const validRelay = {
    type: 'webhook.relay',
    messageId: 'msg-100',
    routingKey: 'github:12345',
    deliveryId: 'del-abc',
    event: 'pull_request',
    action: 'opened',
    payload: { pull_request: { number: 42 } },
  };

  it('validates a well-formed relay message', () => {
    expect(webhookRelaySchema.parse(validRelay)).toEqual(validRelay);
  });

  it('accepts null action', () => {
    const msg = { ...validRelay, action: null };
    expect(webhookRelaySchema.parse(msg)).toEqual(msg);
  });

  it('rejects missing deliveryId', () => {
    const { deliveryId, ...rest } = validRelay;
    expect(() => webhookRelaySchema.parse(rest)).toThrow();
  });

  it('round-trips through JSON serialization', () => {
    const roundTripped = JSON.parse(JSON.stringify(validRelay));
    expect(webhookRelaySchema.parse(roundTripped)).toEqual(validRelay);
  });

  it('accepts optional requestId for distributed tracing', () => {
    const msg = { ...validRelay, requestId: '550e8400-e29b-41d4-a716-446655440000' };
    const parsed = webhookRelaySchema.parse(msg);
    expect(parsed.requestId).toBe('550e8400-e29b-41d4-a716-446655440000');
  });

  it('parses successfully without requestId (backward compatibility)', () => {
    const parsed = webhookRelaySchema.parse(validRelay);
    expect(parsed.requestId).toBeUndefined();
  });
});

describe('webhookAckSchema', () => {
  it('validates a well-formed ack', () => {
    const msg = { type: 'webhook.ack', messageId: 'msg-101', deliveryId: 'del-abc' };
    expect(webhookAckSchema.parse(msg)).toEqual(msg);
  });

  it('rejects missing deliveryId', () => {
    expect(() => webhookAckSchema.parse({ type: 'webhook.ack', messageId: 'msg-101' })).toThrow();
  });

  it('accepts optional result enum from chunked relay path', () => {
    const msg = {
      type: 'webhook.ack',
      messageId: 'msg-101',
      deliveryId: 'del-abc',
      result: 'accepted' as const,
    };
    expect(webhookAckSchema.parse(msg)).toEqual(msg);
  });

  it('accepts result + reason for rejection cases', () => {
    const msg = {
      type: 'webhook.ack',
      messageId: 'msg-101',
      deliveryId: 'del-abc',
      result: 'rejected_signature' as const,
      reason: 'no rotation secret matched x-hub-signature-256',
    };
    expect(webhookAckSchema.parse(msg)).toEqual(msg);
  });

  it('rejects invalid result enum', () => {
    expect(() =>
      webhookAckSchema.parse({
        type: 'webhook.ack',
        messageId: 'msg-101',
        deliveryId: 'del-abc',
        result: 'unknown_status',
      }),
    ).toThrow();
  });
});

describe('WebhookRelayResult', () => {
  it('accepts all four enum values', () => {
    for (const v of [
      'accepted',
      'rejected_signature',
      'rejected_unknown_source',
      'rejected_misconfigured',
    ]) {
      expect(WebhookRelayResult.parse(v)).toBe(v);
    }
  });

  it('rejects values outside the enum', () => {
    expect(() => WebhookRelayResult.parse('rejected')).toThrow();
    expect(() => WebhookRelayResult.parse('valid')).toThrow();
    expect(() => WebhookRelayResult.parse('')).toThrow();
  });
});

describe('webhookRelayStartSchema', () => {
  const validStart = {
    type: 'webhook.relay.start',
    messageId: 'msg-relay-1',
    routingKey: 'github:12345',
    deliveryId: 'del-1',
    event: 'push',
    action: null,
    signatureHeaderName: 'x-hub-signature-256',
    signatureHeader: 'sha256=abc123',
    clientIp: '140.82.121.4',
    headers: { 'x-github-event': 'push', 'x-github-delivery': 'del-1' },
    totalSize: 1024,
    chunkCount: 1,
  };

  it('validates a well-formed start frame', () => {
    expect(webhookRelayStartSchema.parse(validStart)).toEqual(validStart);
  });

  it('accepts nullish signature fields (verification_method=none / IP-only)', () => {
    const msg = {
      ...validStart,
      signatureHeaderName: null,
      signatureHeader: null,
    };
    expect(webhookRelayStartSchema.parse(msg)).toEqual(msg);
  });

  it('accepts nullish clientIp', () => {
    const msg = { ...validStart, clientIp: null };
    expect(webhookRelayStartSchema.parse(msg)).toEqual(msg);
  });

  it('accepts empty headers map', () => {
    const msg = { ...validStart, headers: {} };
    expect(webhookRelayStartSchema.parse(msg)).toEqual(msg);
  });

  it('accepts totalSize 0 (empty body)', () => {
    expect(webhookRelayStartSchema.parse({ ...validStart, totalSize: 0 })).toBeDefined();
  });

  it('rejects totalSize over 25 MiB cap', () => {
    expect(() =>
      webhookRelayStartSchema.parse({
        ...validStart,
        totalSize: WEBHOOK_RELAY_MAX_BODY_BYTES + 1,
      }),
    ).toThrow();
  });

  it('accepts totalSize exactly at the 25 MiB cap', () => {
    expect(
      webhookRelayStartSchema.parse({
        ...validStart,
        totalSize: WEBHOOK_RELAY_MAX_BODY_BYTES,
      }),
    ).toBeDefined();
  });

  it('rejects chunkCount of 0', () => {
    expect(() => webhookRelayStartSchema.parse({ ...validStart, chunkCount: 0 })).toThrow();
  });

  it('rejects non-integer totalSize', () => {
    expect(() => webhookRelayStartSchema.parse({ ...validStart, totalSize: 1.5 })).toThrow();
  });

  it('accepts optional requestId for distributed tracing', () => {
    const msg = { ...validStart, requestId: '550e8400-e29b-41d4-a716-446655440000' };
    expect(webhookRelayStartSchema.parse(msg).requestId).toBe(
      '550e8400-e29b-41d4-a716-446655440000',
    );
  });

  it('round-trips through JSON serialization', () => {
    const roundTripped = JSON.parse(JSON.stringify(validStart));
    expect(webhookRelayStartSchema.parse(roundTripped)).toEqual(validStart);
  });

  it('parses through platformToOrchestratorMessageSchema discriminated union', () => {
    const result = platformToOrchestratorMessageSchema.safeParse(validStart);
    expect(result.success).toBe(true);
  });
});

describe('webhookRelayChunkSchema', () => {
  const validChunk = {
    type: 'webhook.relay.chunk',
    messageId: 'msg-relay-1',
    sequence: 0,
    data: 'aGVsbG8gd29ybGQ=',
    final: true,
  };

  it('validates a well-formed chunk frame', () => {
    expect(webhookRelayChunkSchema.parse(validChunk)).toEqual(validChunk);
  });

  it('accepts non-final chunk (mid-stream)', () => {
    const msg = { ...validChunk, sequence: 5, final: false };
    expect(webhookRelayChunkSchema.parse(msg)).toEqual(msg);
  });

  it('accepts empty base64 data (zero-length tail chunk)', () => {
    expect(webhookRelayChunkSchema.parse({ ...validChunk, data: '' })).toBeDefined();
  });

  it('rejects negative sequence', () => {
    expect(() => webhookRelayChunkSchema.parse({ ...validChunk, sequence: -1 })).toThrow();
  });

  it('rejects non-integer sequence', () => {
    expect(() => webhookRelayChunkSchema.parse({ ...validChunk, sequence: 1.5 })).toThrow();
  });

  it('rejects missing final flag', () => {
    const { final, ...rest } = validChunk;
    expect(() => webhookRelayChunkSchema.parse(rest)).toThrow();
  });

  it('round-trips through JSON serialization', () => {
    const roundTripped = JSON.parse(JSON.stringify(validChunk));
    expect(webhookRelayChunkSchema.parse(roundTripped)).toEqual(validChunk);
  });

  it('parses through platformToOrchestratorMessageSchema discriminated union', () => {
    const result = platformToOrchestratorMessageSchema.safeParse(validChunk);
    expect(result.success).toBe(true);
  });
});

describe('executionEventSchema', () => {
  const validEvent = {
    type: 'execution.event',
    messageId: 'msg-102',
    runId: 'run-001',
    event: 'started',
    data: { workflowName: 'ci' },
    timestamp: Date.now(),
  };

  it('validates a well-formed execution event', () => {
    expect(executionEventSchema.parse(validEvent)).toEqual(validEvent);
  });

  it('validates all event enum values', () => {
    for (const event of ['started', 'job_dispatched', 'job_completed', 'finished']) {
      expect(executionEventSchema.parse({ ...validEvent, event })).toBeDefined();
    }
  });

  it('rejects invalid event value', () => {
    expect(() => executionEventSchema.parse({ ...validEvent, event: 'unknown' })).toThrow();
  });

  it('round-trips through JSON serialization', () => {
    const roundTripped = JSON.parse(JSON.stringify(validEvent));
    expect(executionEventSchema.parse(roundTripped)).toEqual(validEvent);
  });
});

describe('logChunkSchema', () => {
  const validChunk = {
    type: 'log.chunk',
    messageId: 'msg-103',
    runId: 'run-001',
    jobId: 'build',
    stepIndex: 0,
    lines: ['Installing dependencies...', 'Done in 3.2s'],
    timestamp: Date.now(),
  };

  it('validates a well-formed log chunk', () => {
    expect(logChunkSchema.parse(validChunk)).toEqual(validChunk);
  });

  it('accepts empty lines array', () => {
    expect(logChunkSchema.parse({ ...validChunk, lines: [] })).toBeDefined();
  });

  it('rejects missing lines', () => {
    const { lines, ...rest } = validChunk;
    expect(() => logChunkSchema.parse(rest)).toThrow();
  });

  it('round-trips through JSON serialization', () => {
    const roundTripped = JSON.parse(JSON.stringify(validChunk));
    expect(logChunkSchema.parse(roundTripped)).toEqual(validChunk);
  });
});

// --- Source registration schema tests ---

describe('sourceRegistrationSchema', () => {
  const validRegistration = {
    type: 'source.register',
    messageId: 'msg-400',
    sources: [
      {
        provider: 'github',
        routingKey: 'github:12345',
        name: 'Production GitHub App',
        subtype: 'github_app',
      },
      {
        provider: 'gitlab',
        routingKey: 'gitlab:67890',
        name: 'GitLab Mirror',
        subtype: 'universal_git',
      },
    ],
  };

  it('validates a well-formed source registration', () => {
    expect(sourceRegistrationSchema.parse(validRegistration)).toEqual(validRegistration);
  });

  it('accepts empty sources array', () => {
    const msg = { ...validRegistration, sources: [] };
    expect(sourceRegistrationSchema.parse(msg)).toEqual(msg);
  });

  it('validates all provider enum values', () => {
    for (const provider of ['github', 'gitlab', 'bitbucket']) {
      const msg = {
        ...validRegistration,
        sources: [
          {
            provider,
            routingKey: `${provider}:1`,
            name: `${provider} source`,
            subtype: 'github_app',
          },
        ],
      };
      expect(sourceRegistrationSchema.parse(msg)).toBeDefined();
    }
  });

  it('validates all subtype enum values', () => {
    for (const subtype of ['github_app', 'generic_webhook', 'universal_git', 'local']) {
      const msg = {
        ...validRegistration,
        sources: [
          {
            provider: 'generic',
            routingKey: `generic:org:${subtype}`,
            name: `${subtype} source`,
            subtype,
          },
        ],
      };
      expect(sourceRegistrationSchema.parse(msg)).toBeDefined();
    }
  });

  it('rejects invalid provider', () => {
    const msg = {
      ...validRegistration,
      sources: [{ provider: 'unknown', routingKey: 'x:1', name: 'x', subtype: 'github_app' }],
    };
    expect(() => sourceRegistrationSchema.parse(msg)).toThrow();
  });

  it('rejects invalid subtype', () => {
    const msg = {
      ...validRegistration,
      sources: [
        {
          provider: 'github',
          routingKey: 'github:1',
          name: 'x',
          subtype: 'not-a-real-subtype',
        },
      ],
    };
    expect(() => sourceRegistrationSchema.parse(msg)).toThrow();
  });

  it('rejects missing name', () => {
    const msg = {
      ...validRegistration,
      sources: [{ provider: 'github', routingKey: 'github:1', subtype: 'github_app' }],
    };
    expect(() => sourceRegistrationSchema.parse(msg)).toThrow();
  });

  it('rejects missing subtype', () => {
    const msg = {
      ...validRegistration,
      sources: [{ provider: 'github', routingKey: 'github:1', name: 'x' }],
    };
    expect(() => sourceRegistrationSchema.parse(msg)).toThrow();
  });

  it('no longer accepts webhookSecret in source (breaking change)', () => {
    const msg = {
      ...validRegistration,
      sources: [
        {
          provider: 'github',
          routingKey: 'github:1',
          name: 'x',
          subtype: 'github_app',
          webhookSecret: 'secret',
        },
      ],
    };
    // Zod strips unknown keys by default, so this should still parse
    // but webhookSecret will not be present in the output
    const parsed = sourceRegistrationSchema.parse(msg);
    expect((parsed.sources[0] as Record<string, unknown>).webhookSecret).toBeUndefined();
  });

  it('accepts optional instanceId for cluster identity', () => {
    const msg = { ...validRegistration, instanceId: 'orch-1' };
    const parsed = sourceRegistrationSchema.parse(msg);
    expect(parsed.instanceId).toBe('orch-1');
  });

  it('accepts optional address for peer discovery', () => {
    const msg = { ...validRegistration, address: 'wss://orch-1.example.com:9443' };
    const parsed = sourceRegistrationSchema.parse(msg);
    expect(parsed.address).toBe('wss://orch-1.example.com:9443');
  });

  it('accepts null address', () => {
    const msg = { ...validRegistration, address: null };
    const parsed = sourceRegistrationSchema.parse(msg);
    expect(parsed.address).toBeNull();
  });

  it('parses without instanceId or address (backward compatibility)', () => {
    const parsed = sourceRegistrationSchema.parse(validRegistration);
    expect(parsed.instanceId).toBeUndefined();
    expect(parsed.address).toBeUndefined();
  });

  it('accepts optional clusterId (UUID) for cross-cluster collision detection', () => {
    const clusterId = '550e8400-e29b-41d4-a716-446655440000';
    const msg = { ...validRegistration, clusterId };
    const parsed = sourceRegistrationSchema.parse(msg);
    expect(parsed.clusterId).toBe(clusterId);
  });

  it('rejects a clusterId that is not a UUID', () => {
    const msg = { ...validRegistration, clusterId: 'not-a-uuid' };
    expect(() => sourceRegistrationSchema.parse(msg)).toThrow();
  });

  it('round-trips through JSON serialization', () => {
    const roundTripped = JSON.parse(JSON.stringify(validRegistration));
    expect(sourceRegistrationSchema.parse(roundTripped)).toEqual(validRegistration);
  });

  it('round-trips clusterId through JSON serialization', () => {
    const clusterId = '550e8400-e29b-41d4-a716-446655440000';
    const msg = { ...validRegistration, clusterId };
    const roundTripped = JSON.parse(JSON.stringify(msg));
    expect(sourceRegistrationSchema.parse(roundTripped)).toEqual(msg);
  });
});

describe('sourceRegistrationAckSchema', () => {
  const validAck = {
    type: 'source.register.ack',
    messageId: 'msg-401',
    accepted: [
      { routingKey: 'github:12345', webhookUrl: 'https://api.kici.dev/webhook/org_x/github' },
    ],
    rejected: [{ routingKey: 'gitlab:67890', reason: 'Duplicate routing key' }],
  };

  it('validates a well-formed ack', () => {
    expect(sourceRegistrationAckSchema.parse(validAck)).toEqual(validAck);
  });

  it('accepts a null webhookUrl on an accepted source', () => {
    const msg = {
      ...validAck,
      accepted: [{ routingKey: 'github:12345', webhookUrl: null }],
    };
    expect(sourceRegistrationAckSchema.parse(msg)).toEqual(msg);
  });

  it('rejects an accepted entry missing webhookUrl', () => {
    const msg = { ...validAck, accepted: [{ routingKey: 'github:12345' }] };
    expect(() => sourceRegistrationAckSchema.parse(msg)).toThrow();
  });

  it('rejects a bare-string accepted entry (old shape)', () => {
    const msg = { ...validAck, accepted: ['github:12345'] };
    expect(() => sourceRegistrationAckSchema.parse(msg)).toThrow();
  });

  it('accepts all-accepted scenario', () => {
    const msg = { ...validAck, rejected: [] };
    expect(sourceRegistrationAckSchema.parse(msg)).toEqual(msg);
  });

  it('accepts all-rejected scenario', () => {
    const msg = { ...validAck, accepted: [] };
    expect(sourceRegistrationAckSchema.parse(msg)).toEqual(msg);
  });

  it('rejects missing reason in rejected entry', () => {
    const msg = { ...validAck, rejected: [{ routingKey: 'x:1' }] };
    expect(() => sourceRegistrationAckSchema.parse(msg)).toThrow();
  });

  it('accepts optional peers array for discovery', () => {
    const msg = {
      ...validAck,
      peers: [
        {
          connectionId: 'conn-abc',
          instanceId: 'orch-2',
          address: 'wss://orch-2.example.com:9443',
          routingKeys: ['github:12345'],
        },
      ],
    };
    const parsed = sourceRegistrationAckSchema.parse(msg);
    expect(parsed.peers).toHaveLength(1);
    expect(parsed.peers![0].connectionId).toBe('conn-abc');
    expect(parsed.peers![0].instanceId).toBe('orch-2');
  });

  it('accepts peers with null address', () => {
    const msg = {
      ...validAck,
      peers: [
        {
          connectionId: 'conn-abc',
          address: null,
          routingKeys: ['github:12345'],
        },
      ],
    };
    const parsed = sourceRegistrationAckSchema.parse(msg);
    expect(parsed.peers![0].address).toBeNull();
    expect(parsed.peers![0].instanceId).toBeUndefined();
  });

  it('parses without peers (backward compatibility)', () => {
    const parsed = sourceRegistrationAckSchema.parse(validAck);
    expect(parsed.peers).toBeUndefined();
  });

  it('round-trips through JSON serialization', () => {
    const roundTripped = JSON.parse(JSON.stringify(validAck));
    expect(sourceRegistrationAckSchema.parse(roundTripped)).toEqual(validAck);
  });
});

// --- New message type tests ---

describe('peerDiscoverSchema', () => {
  const valid = {
    type: 'peer.discover',
    peer: {
      connectionId: 'conn-abc',
      instanceId: 'orch-2',
      address: 'wss://orch-2.example.com:9443',
      routingKeys: ['github:42', 'github:99'],
    },
  };

  it('validates a well-formed peer.discover message', () => {
    expect(peerDiscoverSchema.parse(valid)).toEqual(valid);
  });

  it('accepts peer with null address', () => {
    const msg = {
      ...valid,
      peer: { ...valid.peer, address: null },
    };
    expect(peerDiscoverSchema.parse(msg)).toEqual(msg);
  });

  it('accepts peer without instanceId', () => {
    const { instanceId, ...peerWithout } = valid.peer;
    const msg = { ...valid, peer: peerWithout };
    const parsed = peerDiscoverSchema.parse(msg);
    expect(parsed.peer.instanceId).toBeUndefined();
  });

  it('accepts peer with empty routingKeys', () => {
    const msg = {
      ...valid,
      peer: { ...valid.peer, routingKeys: [] },
    };
    expect(peerDiscoverSchema.parse(msg)).toEqual(msg);
  });

  it('rejects missing connectionId', () => {
    const { connectionId, ...peerWithout } = valid.peer;
    expect(() => peerDiscoverSchema.parse({ ...valid, peer: peerWithout })).toThrow();
  });

  it('rejects missing peer object', () => {
    expect(() => peerDiscoverSchema.parse({ type: 'peer.discover' })).toThrow();
  });

  it('round-trips through JSON serialization', () => {
    const roundTripped = JSON.parse(JSON.stringify(valid));
    expect(peerDiscoverSchema.parse(roundTripped)).toEqual(valid);
  });
});

describe('peerUpdateSchema', () => {
  const valid = {
    type: 'peer.update',
    peers: [
      {
        connectionId: 'conn-1',
        instanceId: 'inst-1',
        address: 'http://localhost:4000',
        routingKeys: ['github:42'],
        orchRole: 'coordinator' as const,
      },
      {
        connectionId: 'conn-2',
        address: null,
        routingKeys: ['github:42', 'github:99'],
      },
    ],
  };

  it('validates a well-formed peer.update message', () => {
    expect(peerUpdateSchema.parse(valid)).toEqual(valid);
  });

  it('accepts empty peers array', () => {
    const msg = { type: 'peer.update', peers: [] };
    expect(peerUpdateSchema.parse(msg)).toEqual(msg);
  });

  it('accepts peer without orchRole (backward compat)', () => {
    const msg = {
      type: 'peer.update',
      peers: [
        {
          connectionId: 'conn-1',
          address: null,
          routingKeys: ['github:42'],
        },
      ],
    };
    const parsed = peerUpdateSchema.parse(msg);
    expect(parsed.peers[0].orchRole).toBeUndefined();
  });

  it('accepts worker orchRole', () => {
    const msg = {
      type: 'peer.update',
      peers: [
        {
          connectionId: 'conn-1',
          address: null,
          routingKeys: [],
          orchRole: 'worker' as const,
        },
      ],
    };
    const parsed = peerUpdateSchema.parse(msg);
    expect(parsed.peers[0].orchRole).toBe('worker');
  });

  it('rejects invalid orchRole', () => {
    const msg = {
      type: 'peer.update',
      peers: [
        {
          connectionId: 'conn-1',
          address: null,
          routingKeys: [],
          orchRole: 'invalid',
        },
      ],
    };
    expect(() => peerUpdateSchema.parse(msg)).toThrow();
  });

  it('rejects missing peers field', () => {
    expect(() => peerUpdateSchema.parse({ type: 'peer.update' })).toThrow();
  });

  it('round-trips through JSON serialization', () => {
    const roundTripped = JSON.parse(JSON.stringify(valid));
    expect(peerUpdateSchema.parse(roundTripped)).toEqual(valid);
  });

  it('parses through platformToOrchestratorMessageSchema discriminated union', () => {
    const result = platformToOrchestratorMessageSchema.safeParse(valid);
    expect(result.success).toBe(true);
  });
});

// --- Direction-specific union tests ---

describe('platformToOrchestratorMessageSchema', () => {
  it('rejects single-frame webhook.relay (security invariant —)', () => {
    // The legacy single-frame `webhook.relay` schema is intentionally
    // excluded from the wire union: it carries an attacker-controlled
    // `payload` and pre-existed the chunked relay's on-orch HMAC
    // verification, so accepting it on the wire would let a compromised
    // Platform (A10) fabricate webhook deliveries that bypass the only
    // trust boundary against a malicious Platform (the orchestrator-side
    // `verifyInboundWebhook` invoked from `onVerifyInbound` on the chunked
    // path). See the docblock on `webhookRelaySchema` and migration
    // 012_drop_webhook_secret_columns.ts for the design rationale. The
    // chunked path `webhook.relay.start` + `webhook.relay.chunk` is the
    // sole legitimate route from Platform to `onWebhookRelay`.
    const forged = {
      type: 'webhook.relay',
      messageId: 'msg-200',
      routingKey: 'github:1',
      deliveryId: 'del-1',
      event: 'push',
      action: null,
      payload: { ref: 'refs/heads/main' },
    };
    expect(() => platformToOrchestratorMessageSchema.parse(forged)).toThrow();
  });

  it('rejects orchestrator->platform message types (wrong direction)', () => {
    const wrongDirection = {
      type: 'webhook.ack',
      messageId: 'msg-201',
      deliveryId: 'del-1',
    };
    expect(() => platformToOrchestratorMessageSchema.parse(wrongDirection)).toThrow();
  });

  it('accepts auth.success messages', () => {
    const msg = {
      type: 'auth.success',
      connectionId: 'conn-abc',
    };
    expect(platformToOrchestratorMessageSchema.parse(msg)).toEqual(msg);
  });

  it('accepts auth.failure messages', () => {
    const msg = {
      type: 'auth.failure',
      reason: 'Invalid API key',
    };
    expect(platformToOrchestratorMessageSchema.parse(msg)).toEqual(msg);
  });

  it('accepts source.register.ack messages', () => {
    const msg = {
      type: 'source.register.ack',
      messageId: 'msg-210',
      accepted: [{ routingKey: 'github:1', webhookUrl: null }],
      rejected: [],
    };
    expect(platformToOrchestratorMessageSchema.parse(msg)).toEqual(msg);
  });

  it('accepts peer.discover messages', () => {
    const msg = {
      type: 'peer.discover',
      peer: {
        connectionId: 'conn-xyz',
        address: 'wss://peer.example.com:9443',
        routingKeys: ['github:1'],
      },
    };
    expect(platformToOrchestratorMessageSchema.parse(msg)).toBeDefined();
  });

  it('accepts dashboard.environments.history messages', () => {
    const msg = {
      type: 'dashboard.environments.history',
      requestId: 'req-env-hist',
      actor: { type: 'user', sub: 'zsub-test' },
      environmentName: 'production',
      limit: 10,
      offset: 0,
    };
    expect(platformToOrchestratorMessageSchema.parse(msg)).toEqual(msg);
  });

  it('rejects unknown type discriminator', () => {
    expect(() =>
      platformToOrchestratorMessageSchema.parse({ type: 'unknown', messageId: 'x' }),
    ).toThrow();
  });

  it('accepts dashboard.environments.test_access.set messages', () => {
    // The Platform proxies this message verbatim to the orchestrator; if the
    // wire union rejects it, the orchestrator drops the frame and the
    // dashboard's test-access toggle times out with a 504.
    const msg = {
      type: 'dashboard.environments.test_access.set',
      requestId: 'req-env-ta',
      actor: { type: 'user', sub: 'zsub-test' },
      environmentId: 'env-1',
      allowLocalExecution: true,
    };
    expect(platformToOrchestratorMessageSchema.parse(msg)).toEqual(msg);
  });

  it('accepts every dashboardPlatformToOrchSchema member (no union drift)', () => {
    // The orchestrator parses ALL inbound Platform frames against
    // platformToOrchestratorMessageSchema; the Platform routes dashboard
    // requests from the dashboardPlatformToOrchSchema set. Any dashboard
    // request type missing from the wire union is silently dropped on the
    // orchestrator and surfaces as a proxy timeout. Compare discriminator
    // literals so a new dashboard message cannot drift out of the wire union.
    const literalsOf = (schema: z.ZodDiscriminatedUnion): string[] =>
      (schema.options as z.ZodObject<z.ZodRawShape>[]).map((opt) =>
        String((opt.shape.type as z.ZodLiteral<string>).value),
      );
    const wireTypes = new Set(literalsOf(platformToOrchestratorMessageSchema));
    const missing = literalsOf(dashboardPlatformToOrchSchema).filter((t) => !wireTypes.has(t));
    expect(
      missing,
      `dashboard request type(s) missing from platformToOrchestratorMessageSchema — the orchestrator would drop these frames: ${missing.join(', ')}`,
    ).toEqual([]);
  });
});

describe('orchestratorToPlatformMessageSchema', () => {
  it('accepts webhook.ack messages', () => {
    const msg = { type: 'webhook.ack', messageId: 'msg-300', deliveryId: 'del-2' };
    expect(orchestratorToPlatformMessageSchema.parse(msg)).toEqual(msg);
  });

  it('accepts execution.event messages', () => {
    const msg = {
      type: 'execution.event',
      messageId: 'msg-301',
      runId: 'run-1',
      event: 'finished',
      data: {},
      timestamp: 123,
    };
    expect(orchestratorToPlatformMessageSchema.parse(msg)).toEqual(msg);
  });

  it('accepts log.chunk messages', () => {
    const msg = {
      type: 'log.chunk',
      messageId: 'msg-302',
      runId: 'run-1',
      jobId: 'test',
      stepIndex: 1,
      lines: ['PASS'],
      timestamp: 123,
    };
    expect(orchestratorToPlatformMessageSchema.parse(msg)).toEqual(msg);
  });

  it('accepts auth.request messages', () => {
    const msg = {
      type: 'auth.request',
      token: 'kici_sk_test123',
      protocolVersion: 1,
    };
    expect(orchestratorToPlatformMessageSchema.parse(msg)).toEqual(msg);
  });

  it('accepts heartbeat messages', () => {
    const msg = {
      type: 'heartbeat',
      timestamp: Date.now(),
    };
    expect(orchestratorToPlatformMessageSchema.parse(msg)).toEqual(msg);
  });

  it('accepts source.register messages (without webhookSecret)', () => {
    const msg = {
      type: 'source.register',
      messageId: 'msg-310',
      sources: [
        {
          provider: 'github',
          routingKey: 'github:1',
          name: 'GitHub source',
          subtype: 'github_app',
        },
      ],
    };
    expect(orchestratorToPlatformMessageSchema.parse(msg)).toEqual(msg);
  });

  it('accepts cache.stats messages', () => {
    const msg = {
      type: 'cache.stats',
      cacheType: 'source',
      hit: true,
    };
    expect(orchestratorToPlatformMessageSchema.parse(msg)).toEqual(msg);
  });

  it('rejects platform->orchestrator message types (wrong direction)', () => {
    const wrongDirection = {
      type: 'webhook.relay',
      messageId: 'msg-303',
      routingKey: 'github:1',
      deliveryId: 'del-3',
      event: 'push',
      action: null,
      payload: {},
    };
    expect(() => orchestratorToPlatformMessageSchema.parse(wrongDirection)).toThrow();
  });
});

// --- cache.stats schema tests ---

describe('cacheStatsSchema', () => {
  it('validates a source cache hit', () => {
    const msg = { type: 'cache.stats', cacheType: 'source', hit: true };
    expect(cacheStatsSchema.parse(msg)).toEqual(msg);
  });

  it('validates a dep cache miss', () => {
    const msg = { type: 'cache.stats', cacheType: 'dep', hit: false };
    expect(cacheStatsSchema.parse(msg)).toEqual(msg);
  });

  it('rejects invalid cacheType', () => {
    const msg = { type: 'cache.stats', cacheType: 'invalid', hit: true };
    expect(() => cacheStatsSchema.parse(msg)).toThrow();
  });

  it('rejects missing hit field', () => {
    const msg = { type: 'cache.stats', cacheType: 'source' };
    expect(() => cacheStatsSchema.parse(msg)).toThrow();
  });

  it('round-trips through JSON serialization', () => {
    const msg = { type: 'cache.stats', cacheType: 'source', hit: false };
    const roundTripped = JSON.parse(JSON.stringify(msg));
    expect(cacheStatsSchema.parse(roundTripped)).toEqual(msg);
  });
});

// ---------------------------------------------------------------------------
// Platform → orchestrator authentication invariant
//
// The threat model is "rogue Platform impersonator". The TLS handshake is the
// sole Platform-identity check at the connection layer; there is no
// protocol-layer second-line defense — every Platform→orch wire frame is
// trusted implicitly once the WS handshake completes. The matching tripwire
// test in packages/orchestrator/src/ws/platform-client.test.ts pins the
// absence of CA pinning / checkServerIdentity / pinned-roots agent on the
// WS constructor.
//
// THIS test is the codified pin for the *protocol-layer* half of the same
// invariant: if a future PR adds a per-frame Platform-identity field
// (`platformSignature`, `platformAttestation`, `signedBy`, `mac`, `hmac`)
// to ANY Platform→orch schema, this test fires and forces a deliberate
// re-evaluation. Either we now have a second-line defense (write the
// verification-path test that exercises it), or the field is dead weight
// (don't ship it).
// ---------------------------------------------------------------------------

describe('Platform→orch authentication — no protocol-layer second-line defense (security invariant)', () => {
  // Field names that would imply a per-frame Platform-identity claim. If any
  // of these appear at the top level of a Platform→orch wire schema, the
  // assumption that "TLS handshake is the only Platform-identity check"
  // stops being true — the new field's verification path needs its own
  // tests, and the Platform-identity invariant needs to be re-evaluated.
  //
  // NOT included: `signatureHeaderName` / `signatureHeader` — those are
  // GitHub's HMAC header being transparently FORWARDED inside webhook.relay
  // so the orchestrator can verify the inbound webhook against its locally-
  // stored secret. They are NOT a Platform-identity attestation.
  const FORBIDDEN_PLATFORM_IDENTITY_KEYS = [
    'platformSignature',
    'platformAttestation',
    'signedBy',
    'mac',
    'hmac',
  ] as const;

  /**
   * Walk a schema (single z.object OR z.discriminatedUnion of z.objects)
   * and return every member's top-level shape keys, paired with the
   * member's `type` literal so a failure points at the offending message
   * type rather than just "somewhere in the union".
   */
  function collectMemberShapes(
    schema: z.ZodTypeAny,
  ): Array<{ typeLiteral: string; keys: string[] }> {
    // Discriminated union — walk the .options
    if (schema instanceof z.ZodDiscriminatedUnion) {
      const opts = schema.options as z.ZodObject<z.ZodRawShape>[];
      return opts.map((opt) => {
        const shape = opt.shape;
        const typeField = shape.type as z.ZodLiteral<string> | undefined;
        const typeLiteral =
          typeField && typeField instanceof z.ZodLiteral
            ? String(typeField.value)
            : '<unknown-type>';
        return { typeLiteral, keys: Object.keys(shape) };
      });
    }
    // Single z.object (e.g. logPullPlatformToOrchSchema, joinRequestSchema)
    if (schema instanceof z.ZodObject) {
      const shape = (schema as z.ZodObject<z.ZodRawShape>).shape;
      const typeField = shape.type as z.ZodLiteral<string> | undefined;
      const typeLiteral =
        typeField && typeField instanceof z.ZodLiteral ? String(typeField.value) : '<unknown-type>';
      return [{ typeLiteral, keys: Object.keys(shape) }];
    }
    throw new Error(
      `collectMemberShapes: unsupported schema kind (got ${schema.constructor.name})`,
    );
  }

  // The four Platform→orch schemas the orchestrator's handleMessage actually
  // dispatches against (packages/orchestrator/src/ws/platform-client.ts:612-632):
  //   1. platformToOrchestratorMessageSchema (primary union)
  //   2. logPullPlatformToOrchSchema (log pull fallthrough)
  //   3. joinRequestSchema (join.request relayed via Platform)
  // Plus dashboardPlatformToOrchSchema, which is the dashboard-routed subset
  // that overlaps with #1 — included here for completeness so a future split
  // doesn't silently bypass this test.
  const PLATFORM_TO_ORCH_SCHEMAS: Array<{ name: string; schema: z.ZodTypeAny }> = [
    { name: 'platformToOrchestratorMessageSchema', schema: platformToOrchestratorMessageSchema },
    { name: 'logPullPlatformToOrchSchema', schema: logPullPlatformToOrchSchema },
    { name: 'dashboardPlatformToOrchSchema', schema: dashboardPlatformToOrchSchema },
    { name: 'joinRequestSchema', schema: joinRequestSchema },
  ];

  for (const { name, schema } of PLATFORM_TO_ORCH_SCHEMAS) {
    it(`${name}: no member carries a per-frame Platform-identity field`, () => {
      const members = collectMemberShapes(schema);
      // Sanity: we should have walked something. A schema that returns zero
      // members is itself a regression (the test would silently pass).
      expect(members.length).toBeGreaterThan(0);

      const offenders: Array<{
        typeLiteral: string;
        forbiddenKey: (typeof FORBIDDEN_PLATFORM_IDENTITY_KEYS)[number];
      }> = [];
      for (const { typeLiteral, keys } of members) {
        for (const forbidden of FORBIDDEN_PLATFORM_IDENTITY_KEYS) {
          if (keys.includes(forbidden)) {
            offenders.push({ typeLiteral, forbiddenKey: forbidden });
          }
        }
      }

      // Failure message names the offending message type + field so the
      // re-evaluation can start from the exact regression point.
      expect(
        offenders,
        `Platform→orch schema added Platform-identity field(s); the no-second-line-defense invariant must be re-evaluated. Offenders: ${JSON.stringify(offenders)}`,
      ).toEqual([]);
    });
  }

  it('positive control: a forbidden key on a synthetic union member is detected', () => {
    // Self-test that the introspection helper would actually catch a
    // regression. Build a fake discriminated union with a deliberate
    // `platformSignature` field and confirm collectMemberShapes surfaces it.
    const tainted = z.discriminatedUnion('type', [
      z.object({ type: z.literal('legit'), messageId: z.string() }),
      z.object({
        type: z.literal('tainted'),
        messageId: z.string(),
        platformSignature: z.string(),
      }),
    ]);
    const members = collectMemberShapes(tainted);
    const taintedMember = members.find((m) => m.typeLiteral === 'tainted');
    expect(taintedMember).toBeDefined();
    expect(taintedMember!.keys).toContain('platformSignature');
  });
});

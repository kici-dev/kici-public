/**
 * Fields every protocol-4 sender sets are required on the wire. Each block
 * pairs a refusal (the field is dropped) with the complete frame parsing, so a
 * field that slips back to optional reddens the first test and a requirement
 * that refuses what the sender sends reddens the second.
 */
import { describe, expect, it } from 'vitest';
import type { z } from 'zod';
import { authRequestSchema, authSuccessSchema } from './auth.js';
import { runRerunRequestSchema } from './dashboard.js';
import { executionStatusSchema, stateReplayRunSchema } from './execution-status.js';
import {
  jobRerouteSchema,
  peerClusterSettingsResponseSchema,
  peerToPeerMessageSchema,
  workerClusterSettingsSchema,
} from './peer.js';
import { logChunkSchema, webhookAckSchema } from './platform-orchestrator.js';

function refusesWithout(schema: z.ZodType, complete: Record<string, unknown>, field: string) {
  const { [field]: _dropped, ...rest } = complete;
  return schema.safeParse(rest).success === false;
}

const cases: Array<{
  name: string;
  schema: z.ZodType;
  complete: Record<string, unknown>;
  fields: string[];
}> = [
  {
    name: 'webhook.ack',
    schema: webhookAckSchema,
    complete: { type: 'webhook.ack', messageId: 'm', deliveryId: 'd', result: 'accepted' },
    fields: ['result'],
  },
  {
    name: 'orchestrator log.chunk',
    schema: logChunkSchema,
    complete: {
      type: 'log.chunk',
      messageId: 'm',
      runId: 'r',
      jobId: 'j',
      stepIndex: 0,
      lines: ['x'],
      timestamp: 1,
      stream: 'stdout',
    },
    fields: ['stream'],
  },
  {
    name: 'auth.request',
    schema: authRequestSchema,
    complete: {
      type: 'auth.request',
      token: 't',
      protocolVersion: 4,
      capabilities: { orchRole: 'coordinator' },
    },
    fields: ['capabilities'],
  },
  {
    name: 'auth.success',
    schema: authSuccessSchema,
    complete: {
      type: 'auth.success',
      connectionId: 'c',
      orgPublicAlias: 'oal_abc',
      orgId: 'org_abc',
      githubWebhookUrl: null,
    },
    fields: ['orgPublicAlias', 'orgId', 'githubWebhookUrl'],
  },
  {
    name: 'execution.status',
    schema: executionStatusSchema,
    complete: {
      type: 'execution.status',
      messageId: 'm',
      runId: 'r',
      workflowName: 'ci',
      status: 'running',
      jobCount: 1,
      startedAt: 1,
      timestamp: 1,
      statusEpoch: 0,
    },
    fields: ['statusEpoch'],
  },
  {
    name: 'state.replay run',
    schema: stateReplayRunSchema,
    complete: {
      runId: 'r',
      workflowName: 'ci',
      status: 'running',
      jobCount: 0,
      startedAt: 1,
      statusEpoch: 0,
      jobs: [],
    },
    fields: ['statusEpoch'],
  },
  {
    name: 'run.rerun.request',
    schema: runRerunRequestSchema,
    complete: {
      type: 'run.rerun.request',
      requestId: 'q',
      actor: { type: 'system', component: 'test' },
      runId: 'r',
      routingKey: 'github:1',
    },
    fields: ['routingKey'],
  },
  {
    // The snapshot a peer.clusterSettings.response carries.
    name: 'worker cluster-settings snapshot',
    schema: workerClusterSettingsSchema,
    complete: { agentTokenTtlMs: 1, firecrackerApiSocketWaitMs: 1, concurrencyWaitTimeoutMs: 1 },
    fields: ['firecrackerApiSocketWaitMs', 'concurrencyWaitTimeoutMs'],
  },
];

describe('protocol-4 required fields', () => {
  for (const c of cases) {
    // breaks-if-wrong: requiring a field must not refuse what the sender sends.
    it(`a complete ${c.name} parses`, () => {
      const parsed = c.schema.safeParse(c.complete);
      expect(parsed.error?.issues ?? []).toEqual([]);
    });

    it.each(c.fields)(`${c.name} without %s is refused`, (field) => {
      // fails-when: the field stays optional.
      expect(refusesWithout(c.schema, c.complete, field)).toBe(true);
    });
  }

  it('auth.request refuses capabilities without orchRole', () => {
    // fails-when: orchRole stays optional, so the Platform has to guess the role.
    expect(
      authRequestSchema.safeParse({
        type: 'auth.request',
        token: 't',
        protocolVersion: 4,
        capabilities: {},
      }).success,
    ).toBe(false);
  });

  it('peer.clusterSettings.response refuses a snapshot without concurrencyWaitTimeoutMs', () => {
    // fails-when: the response does not validate its snapshot, so a worker
    // dispatches with no fleet-wide concurrency wait.
    expect(
      peerClusterSettingsResponseSchema.safeParse({
        type: 'peer.clusterSettings.response',
        messageId: 'm',
        version: 1,
        settings: { agentTokenTtlMs: 1, firecrackerApiSocketWaitMs: 1 },
      }).success,
    ).toBe(false);
  });

  it('peer.log.chunk refuses a line without its stream', () => {
    // fails-when: a relayed line's stream stays optional.
    const chunk = { type: 'peer.log.chunk', runId: 'r', jobId: 'j', stepIndex: 0 };
    expect(
      peerToPeerMessageSchema.safeParse({ ...chunk, lines: [{ text: 'x', timestamp: 1 }] }).success,
    ).toBe(false);
    expect(
      peerToPeerMessageSchema.safeParse({
        ...chunk,
        lines: [{ text: 'x', timestamp: 1, stream: 'stderr' }],
      }).success,
    ).toBe(true);
  });

  it('job.reroute refuses a frame without spawnRetry', () => {
    // fails-when: the spawn-retry budget stays optional on the reroute.
    const shape = jobRerouteSchema.shape;
    expect(shape.spawnRetry.safeParse(undefined).success).toBe(false);
    expect(shape.spawnRetry.safeParse({ maxAttempts: 2, backoffMs: 0 }).success).toBe(true);
  });
});

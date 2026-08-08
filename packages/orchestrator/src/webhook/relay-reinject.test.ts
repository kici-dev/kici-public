import { describe, it, expect, vi } from 'vitest';
import {
  buildRelayReinject,
  parseRelayPayload,
  type RelayReinjectSeams,
} from './relay-reinject.js';
import { OverflowSourceKind, type OverflowDelivery } from './ingest-overflow-types.js';
import { WebhookIngestOutcome } from '../pipeline/process-webhook.js';
import type { AdmitResult } from './ingest-admission.js';

const admitted = (): AdmitResult => ({ admitted: true, release: vi.fn() });
const shed = (): AdmitResult => ({ admitted: false, reason: 'queue_full' });

function delivery(over: Partial<OverflowDelivery> = {}): OverflowDelivery {
  return {
    deliveryId: 'wd-1',
    routingKey: 'github:5',
    sourceKind: OverflowSourceKind.enum.relay,
    provider: null,
    event: 'push',
    action: null,
    body: Buffer.from('{"foo":1}', 'utf8').toString('base64'),
    meta: {
      signatureHeaderName: 'x-hub-signature-256',
      signatureHeader: 'sha256=zz',
      clientIp: null,
      headers: { 'content-type': 'application/json', 'x-hub-signature-256': 'sha256=zz' },
    },
    ...over,
  };
}

function makeSeams(over: Partial<RelayReinjectSeams> = {}): RelayReinjectSeams {
  return {
    admit: vi.fn(async () => admitted()),
    verify: vi.fn(async () => ({ result: 'accepted' })),
    resolveProvider: () => 'github',
    process: vi.fn(async () => WebhookIngestOutcome.enum.processed),
    ...over,
  };
}

describe('parseRelayPayload', () => {
  it('parses JSON bodies', () => {
    expect(
      parseRelayPayload(Buffer.from('{"a":1}'), { 'content-type': 'application/json' }),
    ).toEqual({ a: 1 });
  });

  it('treats an empty content-type as JSON', () => {
    expect(parseRelayPayload(Buffer.from('{"b":2}'), { 'content-type': '' })).toEqual({ b: 2 });
  });

  it('returns {} for an empty body', () => {
    expect(parseRelayPayload(Buffer.from(''), { 'content-type': 'application/json' })).toEqual({});
  });

  it('wraps a non-JSON body as rawBody + contentType', () => {
    expect(parseRelayPayload(Buffer.from('hello'), { 'content-type': 'text/plain' })).toEqual({
      rawBody: 'hello',
      contentType: 'text/plain',
    });
  });
});

describe('buildRelayReinject', () => {
  it('re-admits, verifies, and processes a captured relay delivery', async () => {
    const seams = makeSeams();
    const reinject = buildRelayReinject(seams);
    const outcome = await reinject(delivery());
    expect(outcome).toBe(WebhookIngestOutcome.enum.processed);
    expect(seams.admit).toHaveBeenCalledWith('github:5');
    const info = (seams.process as ReturnType<typeof vi.fn>).mock.calls[0]![0];
    expect(info).toMatchObject({
      routingKey: 'github:5',
      deliveryId: 'wd-1',
      event: 'push',
      provider: 'github',
      payload: { foo: 1 },
    });
  });

  it('returns shed (revert) when re-admission sheds', async () => {
    const verify = vi.fn(async () => ({ result: 'accepted' }));
    const seams = makeSeams({ admit: vi.fn(async () => shed()), verify });
    const outcome = await buildRelayReinject(seams)(delivery());
    expect(outcome).toBe(WebhookIngestOutcome.enum.shed);
    expect(verify).not.toHaveBeenCalled(); // never verified after a shed
  });

  it('returns skipped when the delivery no longer verifies, and releases the slot', async () => {
    const release = vi.fn();
    const seams = makeSeams({
      admit: vi.fn(async () => ({ admitted: true, release })),
      verify: vi.fn(async () => ({ result: 'rejected_unknown_source' })),
    });
    const outcome = await buildRelayReinject(seams)(delivery());
    expect(outcome).toBe(WebhookIngestOutcome.enum.skipped);
    expect(seams.process).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('releases the admitted slot even when processing throws', async () => {
    const release = vi.fn();
    const seams = makeSeams({
      admit: vi.fn(async () => ({ admitted: true, release })),
      process: vi.fn(async () => {
        throw new Error('boom');
      }),
    });
    await expect(buildRelayReinject(seams)(delivery())).rejects.toThrow('boom');
    expect(release).toHaveBeenCalledTimes(1);
  });
});

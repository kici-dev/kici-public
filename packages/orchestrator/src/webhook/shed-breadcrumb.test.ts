import { describe, expect, it, vi } from 'vitest';
import type { EventLogWriter } from './event-log.js';
import type { RelayStartMeta } from './relay-buffer.js';
import { recordShedBreadcrumb } from './shed-breadcrumb.js';

function makeMeta(overrides: Partial<RelayStartMeta> = {}): RelayStartMeta {
  return {
    routingKey: 'github:2848097',
    deliveryId: 'f36ea770-ac81-11f1-840c-ebf6f44ab52a',
    event: 'pull_request',
    action: 'closed',
    signatureHeaderName: 'x-hub-signature-256',
    signatureHeader: 'sha256=deadbeef',
    clientIp: '10.0.0.1',
    headers: { 'content-type': 'application/json' },
    totalSize: 9,
    chunkCount: 1,
    ...overrides,
  };
}

/** A writer double exposing the one method the breadcrumb calls. */
function makeWriter(): { writer: EventLogWriter; record: ReturnType<typeof vi.fn> } {
  const record = vi.fn().mockResolvedValue(undefined);
  return { writer: { record } as unknown as EventLogWriter, record };
}

describe('recordShedBreadcrumb', () => {
  it('records a shed row naming the delivery, the org and the shed reason', async () => {
    const { writer, record } = makeWriter();
    const body = Buffer.from('{"action":"closed"}', 'utf8');

    const wrote = await recordShedBreadcrumb(
      { eventLog: writer, resolveOrgId: async () => 'org_kiciStg001' },
      makeMeta(),
      body,
      'loop_overload',
    );

    expect(wrote).toBe(true);
    expect(record).toHaveBeenCalledTimes(1);
    const [info, payload, outcome, opts] = record.mock.calls[0]!;
    expect(info).toMatchObject({
      routingKey: 'github:2848097',
      deliveryId: 'f36ea770-ac81-11f1-840c-ebf6f44ab52a',
      event: 'pull_request',
      action: 'closed',
      provider: 'github',
    });
    // The verbatim wire bytes, so the recorded hash matches what Platform hashed.
    expect((payload as { raw: Buffer }).raw.equals(body)).toBe(true);
    expect(outcome).toMatchObject({
      orgId: 'org_kiciStg001',
      source: 'relay',
      status: 'shed',
      errorMessage: 'ingest admission shed: loop_overload',
    });
    // A breadcrumb records that the delivery was seen, so it must never
    // overwrite an outcome the pipeline already reached for the same id.
    expect(opts).toEqual({ onlyIfAbsent: true });
  });

  it('derives the provider from the routing-key prefix for a generic source', async () => {
    const { writer, record } = makeWriter();

    await recordShedBreadcrumb(
      { eventLog: writer, resolveOrgId: async () => 'org_kiciStg001' },
      makeMeta({ routingKey: 'generic:org_kiciStg001:abc', event: 'ping', action: null }),
      Buffer.from('{}', 'utf8'),
      'queue_full',
    );

    expect(record.mock.calls[0]![0]).toMatchObject({ provider: 'generic', action: null });
  });

  it('writes nothing when the wiring has no event-log writer', async () => {
    const wrote = await recordShedBreadcrumb(
      { eventLog: undefined, resolveOrgId: async () => 'org_kiciStg001' },
      makeMeta(),
      Buffer.from('{}', 'utf8'),
      'loop_overload',
    );
    expect(wrote).toBe(false);
  });

  it('swallows a write failure so the shed ack is never blocked', async () => {
    const record = vi.fn().mockRejectedValue(new Error('db down'));
    const wrote = await recordShedBreadcrumb(
      {
        eventLog: { record } as unknown as EventLogWriter,
        resolveOrgId: async () => 'org_kiciStg001',
      },
      makeMeta(),
      Buffer.from('{}', 'utf8'),
      'loop_overload',
    );
    expect(wrote).toBe(false);
  });

  it('swallows an org-resolution failure the same way', async () => {
    const { writer, record } = makeWriter();
    const wrote = await recordShedBreadcrumb(
      {
        eventLog: writer,
        resolveOrgId: async () => {
          throw new Error('db down');
        },
      },
      makeMeta(),
      Buffer.from('{}', 'utf8'),
      'loop_overload',
    );
    expect(wrote).toBe(false);
    expect(record).not.toHaveBeenCalled();
  });
});

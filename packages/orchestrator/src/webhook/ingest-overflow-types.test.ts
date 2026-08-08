import { describe, it, expect } from 'vitest';
import {
  OverflowStatus,
  OverflowSourceKind,
  OverflowDropReason,
  deliveryFromDirect,
  deliveryFromRelay,
  overflowDeliveryToInfo,
} from './ingest-overflow-types.js';
import type { WebhookInfo } from './handler.js';
import type { RelayStartMeta } from './relay-buffer.js';

describe('ingest-overflow-types', () => {
  it('enumerates the statuses, source kinds, and drop reasons', () => {
    expect(OverflowStatus.options).toEqual(['buffered', 'replaying', 'replayed', 'failed']);
    expect(OverflowSourceKind.options).toEqual(['direct', 'relay']);
    expect(OverflowDropReason.options).toEqual(['cap_full', 'max_attempts']);
  });

  it('round-trips a direct (HTTP) delivery through base64 body + back to WebhookInfo', () => {
    const info: WebhookInfo = {
      routingKey: 'github:42',
      deliveryId: 'd-1',
      event: 'push',
      action: null,
      provider: 'github',
      payload: { ref: 'refs/heads/main', n: 1 },
    };
    const d = deliveryFromDirect(info);
    expect(d.sourceKind).toBe(OverflowSourceKind.enum.direct);
    expect(d.provider).toBe('github');
    // body is base64 of the JSON payload.
    expect(JSON.parse(Buffer.from(d.body, 'base64').toString('utf8'))).toEqual(info.payload);
    const back = overflowDeliveryToInfo(d);
    expect(back).toEqual(info);
  });

  it('captures a relay (WS) delivery with raw body + verify meta', () => {
    const meta: RelayStartMeta = {
      routingKey: 'github:9',
      deliveryId: 'd-2',
      event: 'pull_request',
      action: 'opened',
      signatureHeaderName: 'x-hub-signature-256',
      signatureHeader: 'sha256=abc',
      clientIp: '1.2.3.4',
      headers: { 'content-type': 'application/json', 'x-hub-signature-256': 'sha256=abc' },
      totalSize: 3,
      chunkCount: 1,
      requestId: 'r-1',
    };
    const body = Buffer.from('{"a":1}', 'utf8');
    const d = deliveryFromRelay(meta, body);
    expect(d.sourceKind).toBe(OverflowSourceKind.enum.relay);
    expect(d.deliveryId).toBe('d-2');
    expect(d.event).toBe('pull_request');
    expect(d.action).toBe('opened');
    expect(Buffer.from(d.body, 'base64').equals(body)).toBe(true);
    expect(d.meta.signatureHeaderName).toBe('x-hub-signature-256');
    expect(d.meta.headers['x-hub-signature-256']).toBe('sha256=abc');
    expect(d.meta.requestId).toBe('r-1');
  });
});

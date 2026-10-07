import { describe, expect, it } from 'vitest';
import { decodeCursor, encodeCursor } from './cursor.js';

const b64 = (s: string) => Buffer.from(s, 'utf-8').toString('base64url');

describe('cursor', () => {
  // fails-when: the encoding stops being base64url of the JSON in literal key order
  it('encodes base64url(JSON) in key order', () => {
    expect(encodeCursor({ receivedAt: '2026-04-17T02:00:00.000Z', id: 'id-2' })).toBe(
      'eyJyZWNlaXZlZEF0IjoiMjAyNi0wNC0xN1QwMjowMDowMC4wMDBaIiwiaWQiOiJpZC0yIn0',
    );
  });

  // breaks-if-wrong: a cursor the handler emitted must decode back to its fields
  it('round-trips', () => {
    const fields = { createdAt: '2026-01-15T09:00:00.000Z', runId: 'run-2' };
    expect(decodeCursor(encodeCursor(fields), ['createdAt', 'runId'])).toEqual(fields);
  });

  it('returns only the requested keys', () => {
    expect(
      decodeCursor(b64('{"id":"a","receivedAt":"t","extra":"x"}'), ['receivedAt', 'id']),
    ).toEqual({ receivedAt: 't', id: 'a' });
  });

  // fails-when: a non-string field (a number would reach new Date(n)) is accepted
  it.each([
    ['a missing key', '{"receivedAt":"t"}'],
    ['a number', '{"receivedAt":5,"id":"a"}'],
    ['a null', '{"receivedAt":null,"id":"a"}'],
    ['JSON null', 'null'],
    ['a JSON number', '5'],
    ['not JSON', 'not json'],
  ])('rejects %s', (_label, json) => {
    expect(decodeCursor(b64(json), ['receivedAt', 'id'])).toBeNull();
  });
});

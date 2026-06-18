import { describe, it, expect } from 'vitest';
import {
  actorPrincipalSchema,
  flattenActor,
  parseActor,
  stringifyActor,
  type ActorPrincipal,
} from './actor.js';

describe('ActorPrincipal schema', () => {
  it('accepts a user actor with a non-empty sub', () => {
    const r = actorPrincipalSchema.safeParse({ type: 'user', sub: 'zsub-123' });
    expect(r.success).toBe(true);
  });

  it('rejects a user actor without sub', () => {
    const r = actorPrincipalSchema.safeParse({ type: 'user' });
    expect(r.success).toBe(false);
  });

  it('accepts an api_key actor with keyId + ownerSub', () => {
    const r = actorPrincipalSchema.safeParse({
      type: 'api_key',
      keyId: 'ak_123',
      ownerSub: 'zsub-123',
    });
    expect(r.success).toBe(true);
  });

  it('rejects an api_key actor missing ownerSub', () => {
    const r = actorPrincipalSchema.safeParse({ type: 'api_key', keyId: 'ak_123' });
    expect(r.success).toBe(false);
  });

  it('accepts a service_account actor', () => {
    const r = actorPrincipalSchema.safeParse({ type: 'service_account', id: 'sa-1' });
    expect(r.success).toBe(true);
  });

  it('accepts a platform_operator actor with reason >= 4 chars', () => {
    const r = actorPrincipalSchema.safeParse({
      type: 'platform_operator',
      sub: 'zsub-op-1',
      reason: 'oops',
    });
    expect(r.success).toBe(true);
  });

  it('accepts a platform_operator actor carrying a sessionId', () => {
    const r = actorPrincipalSchema.safeParse({
      type: 'platform_operator',
      sub: 'zsub-op-1',
      reason: 'ticket-1234',
      sessionId: 'sess-abc',
    });
    expect(r.success).toBe(true);
  });

  it('rejects a platform_operator with short reason (< 4 chars)', () => {
    const r = actorPrincipalSchema.safeParse({
      type: 'platform_operator',
      sub: 'zsub-op-1',
      reason: 'abc',
    });
    expect(r.success).toBe(false);
  });

  it('rejects a platform_operator with reason over 200 chars', () => {
    const r = actorPrincipalSchema.safeParse({
      type: 'platform_operator',
      sub: 'zsub-op-1',
      reason: 'x'.repeat(201),
    });
    expect(r.success).toBe(false);
  });

  it('accepts a system actor', () => {
    const r = actorPrincipalSchema.safeParse({ type: 'system', component: 'scheduler' });
    expect(r.success).toBe(true);
  });

  it('rejects an unknown actor type', () => {
    const r = actorPrincipalSchema.safeParse({ type: 'other', sub: 'x' });
    expect(r.success).toBe(false);
  });
});

describe('stringifyActor / parseActor', () => {
  const cases: Array<{ actor: ActorPrincipal; wire: string }> = [
    { actor: { type: 'user', sub: 'z1' }, wire: 'user:z1' },
    { actor: { type: 'api_key', keyId: 'ak1', ownerSub: 'z1' }, wire: 'api_key:ak1' },
    { actor: { type: 'service_account', id: 'sa-1' }, wire: 'service_account:sa-1' },
    {
      actor: { type: 'platform_operator', sub: 'z-op', reason: 'ticket-1234' },
      wire: 'platform_operator:z-op',
    },
    { actor: { type: 'system', component: 'scheduler' }, wire: 'system:scheduler' },
  ];

  for (const { actor, wire } of cases) {
    it(`stringifies ${actor.type}`, () => {
      expect(stringifyActor(actor)).toBe(wire);
    });
  }

  it('parses a known prefix', () => {
    expect(parseActor('user:z1')).toEqual({ type: 'user', id: 'z1' });
    expect(parseActor('platform_operator:z-op')).toEqual({
      type: 'platform_operator',
      id: 'z-op',
    });
  });

  it('returns null for null / empty / malformed input', () => {
    expect(parseActor(null)).toBeNull();
    expect(parseActor(undefined)).toBeNull();
    expect(parseActor('')).toBeNull();
    expect(parseActor('user:')).toBeNull();
    expect(parseActor(':z1')).toBeNull();
    expect(parseActor('bogus:z1')).toBeNull();
    expect(parseActor('no-colon')).toBeNull();
  });

  it('preserves colons inside the id portion', () => {
    // sub can contain colons (some IdPs include them) — only the
    // first colon is the separator.
    expect(parseActor('user:a:b:c')).toEqual({ type: 'user', id: 'a:b:c' });
  });
});

describe('flattenActor', () => {
  it('flattens user → no meta', () => {
    expect(flattenActor({ type: 'user', sub: 'z1' })).toEqual({
      actorType: 'user',
      actorId: 'z1',
      actorMeta: null,
    });
  });

  it('flattens api_key → ownerSub in meta', () => {
    expect(flattenActor({ type: 'api_key', keyId: 'ak1', ownerSub: 'z1' })).toEqual({
      actorType: 'api_key',
      actorId: 'ak1',
      actorMeta: { ownerSub: 'z1' },
    });
  });

  it('flattens platform_operator → reason in meta', () => {
    expect(flattenActor({ type: 'platform_operator', sub: 'z-op', reason: 'ticket-1234' })).toEqual(
      {
        actorType: 'platform_operator',
        actorId: 'z-op',
        actorMeta: { reason: 'ticket-1234' },
      },
    );
  });

  it('flattens platform_operator → reason + sessionId in meta when a session is present', () => {
    expect(
      flattenActor({
        type: 'platform_operator',
        sub: 'z-op',
        reason: 'ticket-1234',
        sessionId: 'sess-abc',
      }),
    ).toEqual({
      actorType: 'platform_operator',
      actorId: 'z-op',
      actorMeta: { reason: 'ticket-1234', sessionId: 'sess-abc' },
    });
  });

  it('flattens service_account → no meta', () => {
    expect(flattenActor({ type: 'service_account', id: 'sa-1' })).toEqual({
      actorType: 'service_account',
      actorId: 'sa-1',
      actorMeta: null,
    });
  });

  it('flattens system → no meta', () => {
    expect(flattenActor({ type: 'system', component: 'scheduler' })).toEqual({
      actorType: 'system',
      actorId: 'scheduler',
      actorMeta: null,
    });
  });
});

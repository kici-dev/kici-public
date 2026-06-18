import { describe, expect, it } from 'vitest';
import {
  activityCursorSchema,
  activityFilterSchema,
  activityRowSchema,
  decodeActivityCursor,
  encodeActivityCursor,
  resolveRunIdSugar,
  type ActivityCursor,
  type ActivityFilter,
  type ActivityRow,
} from './activity.js';

describe('activityFilterSchema', () => {
  it('applies defaults for source / limit', () => {
    const parsed = activityFilterSchema.parse({});
    expect(parsed.source).toBe('all');
    expect(parsed.limit).toBe(50);
  });

  it('coerces limit from string (URL query semantics)', () => {
    const parsed = activityFilterSchema.parse({ limit: '120' });
    expect(parsed.limit).toBe(120);
  });

  it('rejects limit > 200', () => {
    expect(() => activityFilterSchema.parse({ limit: 9999 })).toThrow();
  });

  it('accepts the CLI-equivalent filter set', () => {
    const parsed = activityFilterSchema.parse({
      actorType: 'user',
      actorId: 'sub-123',
      action: 'run.detail.read',
      outcome: 'denied',
      origin: 'platform_proxy',
      targetType: 'run',
      targetId: 'run_abc',
      from: '2026-04-01T00:00:00Z',
      to: '2026-04-25T00:00:00Z',
      q: 'permission',
      runId: 'run_xyz',
    });
    expect(parsed.actorType).toBe('user');
    expect(parsed.runId).toBe('run_xyz');
    expect(parsed.q).toBe('permission');
  });

  it('rejects unknown actor types', () => {
    expect(() => activityFilterSchema.parse({ actorType: 'martian' })).toThrow();
  });
});

describe('activityRowSchema', () => {
  it('accepts an audit_log row with null outcome / errorMessage', () => {
    const row: ActivityRow = {
      id: 'a1',
      source: 'audit_log',
      createdAt: '2026-04-25T10:00:00Z',
      actorType: 'user',
      actorId: 'sub-1',
      actorMeta: null,
      action: 'member.invite',
      targetType: 'user',
      targetId: 'sub-2',
      outcome: null,
      errorMessage: null,
      details: { invited_email: 'foo@bar.com' },
    };
    expect(activityRowSchema.parse(row)).toMatchObject({ source: 'audit_log', outcome: null });
  });

  it('accepts an access_log row with origin / requestId / outcome', () => {
    const row: ActivityRow = {
      id: 'b1',
      source: 'access_log',
      createdAt: '2026-04-25T10:01:00Z',
      actorType: 'user',
      actorId: 'sub-1',
      actorMeta: null,
      actorEmail: 'foo@bar.com',
      actorDisplayName: 'Foo Bar',
      action: 'run.detail.read',
      targetType: 'run',
      targetId: 'run_abc',
      outcome: 'allowed',
      errorMessage: null,
      details: null,
      requestId: 'req-1',
      origin: 'platform_proxy',
    };
    expect(activityRowSchema.parse(row).origin).toBe('platform_proxy');
  });

  it('rejects rows with an invalid source discriminator', () => {
    expect(() =>
      activityRowSchema.parse({
        id: 'x',
        source: 'event_log',
        createdAt: '2026-04-25T10:00:00Z',
        actorType: 'user',
        actorId: 'sub-1',
        actorMeta: null,
        action: 'foo',
        targetType: null,
        targetId: null,
        outcome: null,
        errorMessage: null,
        details: null,
      }),
    ).toThrow();
  });
});

describe('cursor encode/decode round-trip', () => {
  it('round-trips a both-sources-active cursor', () => {
    const cursor: ActivityCursor = {
      audit: { offset: 50 },
      access: { inner: 'orch-cursor-abc' },
    };
    const encoded = encodeActivityCursor(cursor);
    expect(typeof encoded).toBe('string');
    expect(encoded).not.toContain('+');
    expect(encoded).not.toContain('/');
    expect(encoded).not.toContain('=');
    const decoded = decodeActivityCursor(encoded);
    expect(decoded).toEqual(cursor);
  });

  it('round-trips a half-exhausted cursor', () => {
    const cursor: ActivityCursor = {
      audit: null,
      access: { inner: 'orch-cursor-tail' },
    };
    expect(decodeActivityCursor(encodeActivityCursor(cursor))).toEqual(cursor);
  });

  it('round-trips a fully-exhausted cursor (both null)', () => {
    const cursor: ActivityCursor = { audit: null, access: null };
    expect(decodeActivityCursor(encodeActivityCursor(cursor))).toEqual(cursor);
  });

  it('returns null for malformed base64', () => {
    expect(decodeActivityCursor('!!!not-base64!!!')).toBeNull();
  });

  it('returns null for valid base64 of non-JSON', () => {
    const garbage = btoa('this is not json');
    expect(decodeActivityCursor(garbage)).toBeNull();
  });

  it('returns null for valid JSON that fails the schema', () => {
    const wrongShape = btoa(JSON.stringify({ foo: 'bar' }));
    expect(decodeActivityCursor(wrongShape)).toBeNull();
  });

  it('rejects cursor with negative offset', () => {
    const bad = btoa(JSON.stringify({ audit: { offset: -1 }, access: null }));
    expect(decodeActivityCursor(bad)).toBeNull();
  });

  it('cursor schema validates expected shape', () => {
    expect(() => activityCursorSchema.parse({ audit: { offset: 0 }, access: null })).not.toThrow();
  });
});

describe('resolveRunIdSugar', () => {
  it('maps runId to (targetType=run, targetId=runId) when target fields are absent', () => {
    const filter: ActivityFilter = activityFilterSchema.parse({ runId: 'run_42' });
    const resolved = resolveRunIdSugar(filter);
    expect(resolved.targetType).toBe('run');
    expect(resolved.targetId).toBe('run_42');
  });

  it('preserves explicit targetType/targetId when both are set', () => {
    const filter: ActivityFilter = activityFilterSchema.parse({
      runId: 'run_42',
      targetType: 'job',
      targetId: 'job_x',
    });
    const resolved = resolveRunIdSugar(filter);
    expect(resolved.targetType).toBe('job');
    expect(resolved.targetId).toBe('job_x');
  });

  it('is a no-op when runId is absent', () => {
    const filter: ActivityFilter = activityFilterSchema.parse({});
    expect(resolveRunIdSugar(filter)).toBe(filter);
  });
});

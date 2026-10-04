import { describe, expect, it } from 'vitest';

import {
  JoinErrorCode,
  JoinRequestKind,
  buildJoinRefusal,
  classifyJoinRequest,
  isJoinRequestFrame,
  joinRequestSchema,
  joinResponseSchema,
} from './join.js';

const V2 = {
  type: 'join.request',
  joinProtocol: 2,
  routing: Buffer.from('{"orgId":"o","routingKey":"k","expiry":1}').toString('base64url'),
  joinerPublicKey: Buffer.alloc(44, 1).toString('base64'),
  joinerNonce: Buffer.alloc(32, 2).toString('base64'),
  joinerProof: 'ab'.repeat(32),
};

describe('classifyJoinRequest', () => {
  it('a token-carrying frame is v1_removed, with its messageId', () => {
    expect(
      classifyJoinRequest({ type: 'join.request', messageId: 'm1', token: 'kici_join_v1.a.b' }),
    ).toEqual({ kind: JoinRequestKind.enum.v1_removed, messageId: 'm1' });
  });

  // fails-when: the classifier parses before checking for `token` (zod strips the key,
  //   so the frame would read as v2).
  it('a frame with token AND v2 fields is still v1_removed', () => {
    expect(classifyJoinRequest({ ...V2, token: 'kici_join_v1.a.b' }).kind).toBe(
      JoinRequestKind.enum.v1_removed,
    );
  });

  it('a partial v2 frame is invalid, and keeps its messageId', () => {
    const { joinerProof: _omit, ...partial } = V2;
    expect(classifyJoinRequest({ ...partial, messageId: 'm2' })).toEqual({
      kind: JoinRequestKind.enum.invalid,
      messageId: 'm2',
    });
  });

  // breaks-if-wrong: a full v2 frame classifies as v2 and carries no token key.
  it('a full v2 frame is v2', () => {
    const out = classifyJoinRequest(V2);
    expect(out.kind).toBe(JoinRequestKind.enum.v2);
    expect(out.kind === JoinRequestKind.enum.v2 && 'token' in out.request).toBe(false);
  });

  it('non-objects are invalid', () => {
    expect(classifyJoinRequest(null).kind).toBe(JoinRequestKind.enum.invalid);
    expect(classifyJoinRequest('join.request').kind).toBe(JoinRequestKind.enum.invalid);
    expect(classifyJoinRequest([V2]).kind).toBe(JoinRequestKind.enum.invalid);
  });

  it('drops an over-long messageId instead of echoing it', () => {
    expect(classifyJoinRequest({ type: 'join.request', messageId: 'x'.repeat(257) })).toEqual({
      kind: JoinRequestKind.enum.invalid,
      messageId: undefined,
    });
  });
});

describe('join schemas', () => {
  it('rejects an uppercase proof, a dotted routing part, and an oversized key', () => {
    expect(joinRequestSchema.safeParse({ ...V2, joinerProof: 'AB'.repeat(32) }).success).toBe(
      false,
    );
    expect(joinRequestSchema.safeParse({ ...V2, routing: 'a.b' }).success).toBe(false);
    expect(joinRequestSchema.safeParse({ ...V2, joinerPublicKey: 'A'.repeat(132) }).success).toBe(
      false,
    );
    expect(joinRequestSchema.safeParse({ ...V2, joinProtocol: 1 }).success).toBe(false);
  });

  it('has no top-level token, mac or hmac field', () => {
    const keys = Object.keys(joinRequestSchema.shape);
    expect(keys).not.toContain('mac');
    expect(keys).not.toContain('hmac');
    expect(keys).not.toContain('token');
  });

  // fails-when: the response schema lacks the v2 fields (zod strips unknown keys, so a
  //   relay that parses would drop them).
  it('keeps the v2 response fields and the error code through a parse', () => {
    const parsed = joinResponseSchema.parse({
      type: 'join.response',
      success: true,
      joinProtocol: 2,
      serverPublicKey: 'QUJD',
      serverNonce: 'QUJD',
      serverProof: 'cd'.repeat(32),
      encryptedBundle: 'QUJD',
    });
    expect(parsed).toMatchObject({
      joinProtocol: 2,
      serverPublicKey: 'QUJD',
      serverProof: 'cd'.repeat(32),
      serverNonce: 'QUJD',
      encryptedBundle: 'QUJD',
    });
    expect(
      joinResponseSchema.parse(buildJoinRefusal('m', JoinErrorCode.enum.invalid_token, 'x'))
        .errorCode,
    ).toBe(JoinErrorCode.enum.invalid_token);
  });

  it('buildJoinRefusal sets every refusal field', () => {
    expect(buildJoinRefusal('m', JoinErrorCode.enum.no_target, 'none')).toEqual({
      type: 'join.response',
      messageId: 'm',
      success: false,
      errorCode: JoinErrorCode.enum.no_target,
      error: 'none',
    });
  });

  it('isJoinRequestFrame matches only join.request objects', () => {
    expect(isJoinRequestFrame({ type: 'join.request' })).toBe(true);
    expect(isJoinRequestFrame({ type: 'join.response' })).toBe(false);
    expect(isJoinRequestFrame(undefined)).toBe(false);
  });
});

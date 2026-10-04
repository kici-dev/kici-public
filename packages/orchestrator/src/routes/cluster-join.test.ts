import { describe, expect, it, vi } from 'vitest';
import { JOIN_PROTOCOL_UPGRADE_TOKEN, JoinErrorCode, buildJoinRefusal } from '@kici-dev/engine';

import { createClusterJoinRoutes } from './cluster-join.js';

const post = (app: ReturnType<typeof createClusterJoinRoutes>, body: string) =>
  app.request('/api/v1/cluster/join', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
  });

describe('POST /api/v1/cluster/join', () => {
  // fails-when: a v1 body reaches the handler, or the status is not 426.
  it('answers a v1 body with 426 and the Upgrade header, without calling the handler', async () => {
    const handler = vi.fn();
    const res = await post(
      createClusterJoinRoutes(handler),
      JSON.stringify({ token: 'kici_join_v1.a.b' }),
    );
    expect(res.status).toBe(426);
    expect(res.headers.get('Upgrade')).toBe(JOIN_PROTOCOL_UPGRADE_TOKEN);
    expect((await res.json()).errorCode).toBe(JoinErrorCode.enum.join_protocol_v1_removed);
    expect(handler).not.toHaveBeenCalled();
  });

  it('answers malformed JSON with 400 invalid_request', async () => {
    const handler = vi.fn();
    const res = await post(createClusterJoinRoutes(handler), '{nope');
    expect(res.status).toBe(400);
    expect((await res.json()).errorCode).toBe(JoinErrorCode.enum.invalid_request);
    expect(handler).not.toHaveBeenCalled();
  });

  // breaks-if-wrong: a v2 body reaches the handler and a success is 200.
  it('passes a v2 body to the handler and maps its answer', async () => {
    const handler = vi.fn().mockResolvedValue({ type: 'join.response', success: true });
    const res = await post(
      createClusterJoinRoutes(handler),
      JSON.stringify({ type: 'join.request', joinProtocol: 2 }),
    );
    expect(res.status).toBe(200);
    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'join.request', joinProtocol: 2 }),
    );
  });

  it('sets the frame type on a body that omits it', async () => {
    const handler = vi.fn().mockResolvedValue({ type: 'join.response', success: true });
    await post(createClusterJoinRoutes(handler), JSON.stringify({ joinProtocol: 2 }));
    expect(handler).toHaveBeenCalledWith({ type: 'join.request', joinProtocol: 2 });
  });

  it.each([
    [JoinErrorCode.enum.invalid_request, 400],
    [JoinErrorCode.enum.invalid_token, 401],
    [JoinErrorCode.enum.token_expired, 401],
    [JoinErrorCode.enum.token_already_used, 401],
  ])('maps %s to %i', async (code, status) => {
    const handler = vi.fn().mockResolvedValue(buildJoinRefusal(undefined, code, 'x'));
    expect((await post(createClusterJoinRoutes(handler), '{"type":"join.request"}')).status).toBe(
      status,
    );
  });

  it('answers 500 for a refusal without a code and for a thrown handler', async () => {
    const noCode = vi
      .fn()
      .mockResolvedValue({ type: 'join.response', success: false, error: 'db down' });
    expect((await post(createClusterJoinRoutes(noCode), '{}')).status).toBe(500);
    const throws = vi.fn().mockRejectedValue(new Error('boom'));
    const res = await post(createClusterJoinRoutes(throws), '{}');
    expect(res.status).toBe(500);
    expect(JSON.stringify(await res.json())).not.toContain('boom');
  });
});

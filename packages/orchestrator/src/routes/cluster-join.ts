/**
 * POST /api/v1/cluster/join: the direct transport of `kici-admin join --peer`.
 *
 * The body is the same join.request the Platform relays. Unauthenticated by design:
 * the joiner proves it holds a join token inside the request. A version-1 body (one
 * that carries the token) is refused with 426 and `Upgrade: kici-join-v2`.
 */
import { Hono } from 'hono';
import {
  INVALID_JOIN_REQUEST_MESSAGE,
  JOIN_PROTOCOL_UPGRADE_TOKEN,
  JOIN_PROTOCOL_V1_REMOVED_MESSAGE,
  JoinErrorCode,
  JoinRequestKind,
  buildJoinRefusal,
  classifyJoinRequest,
  type JoinResponse,
} from '@kici-dev/engine';

const UNAUTHORIZED_CODES: ReadonlySet<JoinErrorCode> = new Set([
  JoinErrorCode.enum.invalid_token,
  JoinErrorCode.enum.token_expired,
  JoinErrorCode.enum.token_already_used,
]);

/** HTTP status for a join answer: a refusal without an error code is an internal failure. */
export function joinResponseHttpStatus(response: JoinResponse): 200 | 400 | 401 | 426 | 500 {
  if (response.success) return 200;
  if (response.errorCode === JoinErrorCode.enum.invalid_request) return 400;
  if (response.errorCode === JoinErrorCode.enum.join_protocol_v1_removed) return 426;
  if (response.errorCode && UNAUTHORIZED_CODES.has(response.errorCode)) return 401;
  return 500;
}

export function createClusterJoinRoutes(
  onJoinRequest: (raw: unknown) => Promise<JoinResponse>,
): Hono {
  return new Hono().post('/api/v1/cluster/join', async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json(
        buildJoinRefusal(
          undefined,
          JoinErrorCode.enum.invalid_request,
          INVALID_JOIN_REQUEST_MESSAGE,
        ),
        400,
      );
    }
    const frame =
      typeof body === 'object' && body !== null && !Array.isArray(body)
        ? { ...(body as Record<string, unknown>), type: 'join.request' }
        : body;
    if (classifyJoinRequest(frame).kind === JoinRequestKind.enum.v1_removed) {
      c.header('Upgrade', JOIN_PROTOCOL_UPGRADE_TOKEN);
      return c.json(
        buildJoinRefusal(
          undefined,
          JoinErrorCode.enum.join_protocol_v1_removed,
          JOIN_PROTOCOL_V1_REMOVED_MESSAGE,
        ),
        426,
      );
    }
    try {
      const response = await onJoinRequest(frame);
      return c.json(response, joinResponseHttpStatus(response));
    } catch {
      return c.json({ type: 'join.response', success: false, error: 'Internal error' }, 500);
    }
  });
}

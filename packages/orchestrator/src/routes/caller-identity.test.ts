import { describe, it, expect, vi } from 'vitest';
import { Hono } from 'hono';
import { ActorType } from '@kici-dev/engine';
import { AUTH_ERROR, type AuthTokenInfo, type AuthTokenValidator } from './admin-auth.js';
import { callerActor, resolveCaller, type CallerOutcome } from './caller-identity.js';
import { UNSCOPED_REQUIRED_MESSAGE } from '../secrets/routing-key-scope.js';

const UNSCOPED: AuthTokenInfo = {
  id: 'tok-1',
  role: 'owner',
  routingKey: null,
  label: 'dev',
  subject: 'alice@example.test',
};

/** Run resolveCaller inside a real Hono request and return its outcome. */
async function resolve(
  validator: AuthTokenValidator,
  opts: { requireUnscoped: boolean },
  authorization?: string,
): Promise<CallerOutcome> {
  let outcome: CallerOutcome | undefined;
  const app = new Hono();
  app.get('/x', async (c) => {
    outcome = await resolveCaller(
      c,
      { tokenManager: validator, scope: 'test', logger: { error: vi.fn() } },
      opts,
    );
    return c.text('ok');
  });
  await app.request('/x', { headers: authorization ? { Authorization: authorization } : {} });
  return outcome!;
}

const returns = (info: AuthTokenInfo | null): AuthTokenValidator => ({
  validate: vi.fn(async () => info),
});

describe('resolveCaller', () => {
  it('resolves a valid unscoped token into a token caller with its subject', async () => {
    const outcome = await resolve(returns(UNSCOPED), { requireUnscoped: true }, 'Bearer t');
    expect(outcome).toEqual({
      ok: true,
      caller: {
        kind: 'token',
        tokenId: 'tok-1',
        label: 'dev',
        subject: 'alice@example.test',
        role: 'owner',
        routingKeyScope: null,
      },
    });
  });

  it('maps an absent subject to null', async () => {
    const { subject: _omit, ...noSubject } = UNSCOPED;
    const outcome = await resolve(returns(noSubject), { requireUnscoped: false }, 'Bearer t');
    expect(outcome.ok && outcome.caller.subject).toBeNull();
  });

  it('answers 401 missing without a bearer header', async () => {
    expect(await resolve(returns(UNSCOPED), { requireUnscoped: false })).toEqual({
      ok: false,
      status: 401,
      error: AUTH_ERROR.missing,
    });
  });

  it('answers 401 invalid for an unknown token', async () => {
    expect(await resolve(returns(null), { requireUnscoped: false }, 'Bearer nope')).toEqual({
      ok: false,
      status: 401,
      error: AUTH_ERROR.invalid,
    });
  });

  it('answers 503 when the validator cannot complete', async () => {
    const throwing: AuthTokenValidator = {
      validate: vi.fn(async () => {
        throw new Error('pool exhausted');
      }),
    };
    expect(await resolve(throwing, { requireUnscoped: false }, 'Bearer t')).toEqual({
      ok: false,
      status: 503,
      error: AUTH_ERROR.unavailable,
    });
  });

  it('refuses a routing-key-scoped token when the route requires an unscoped one', async () => {
    const scoped = { ...UNSCOPED, routingKey: 'github:42' };
    // fails-when: a routing-key token reaches a route whose routing key the server chooses
    expect(await resolve(returns(scoped), { requireUnscoped: true }, 'Bearer t')).toEqual({
      ok: false,
      status: 403,
      error: UNSCOPED_REQUIRED_MESSAGE,
    });
  });

  it('accepts a scoped token when the route does not require an unscoped one', async () => {
    const scoped = { ...UNSCOPED, routingKey: 'github:42' };
    // breaks-if-wrong: a scoped token still authenticates where scope is checked per request
    const outcome = await resolve(returns(scoped), { requireUnscoped: false }, 'Bearer t');
    expect(outcome.ok && outcome.caller.routingKeyScope).toBe('github:42');
  });
});

describe('callerActor', () => {
  it('attributes a token caller as a service account bearing the token id', () => {
    const outcome = {
      kind: 'token' as const,
      tokenId: 'tok-9',
      label: 'x',
      subject: null,
      role: 'admin' as const,
      routingKeyScope: null,
    };
    expect(callerActor(outcome)).toEqual({ type: ActorType.enum.service_account, id: 'tok-9' });
  });
});

import { afterEach, describe, expect, it, vi } from 'vitest';
import { CLI_LOGIN_CONFIG_PATH, CliLoginConfigError } from '@kici-dev/engine';
import { LoginTargetSource, fetchCliLoginConfig, resolveLoginTarget } from './login-target.js';
import { PROD_OIDC_CLIENT_ID, PROD_OIDC_ISSUER, PROD_PLATFORM_URL } from './prod-defaults.js';
import { ClientNewerThanPlatformError } from './platform-fetch.js';

/** A fake `fetch` that records every URL it is asked for and answers with `respond`. */
function recordingFetch(respond: (url: string) => Response | Promise<Response>) {
  const calls: string[] = [];
  const fetchImpl = (async (input: string | URL | Request) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    calls.push(url);
    return respond(url);
  }) as typeof fetch;
  return { calls, fetchImpl };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const PUBLISHED = {
  issuer: 'https://login.corp.example/realms/eng',
  clientId: 'corp-cli',
};

/** The target every hosted-default path resolves to. */
const HOSTED_TARGET = {
  platformUrl: PROD_PLATFORM_URL,
  issuer: PROD_OIDC_ISSUER,
  clientId: PROD_OIDC_CLIENT_ID,
  source: LoginTargetSource.enum.hosted_default,
  extraScopes: [],
};

/** Every fetch fails the test: the path under test must make no request. */
function forbiddenFetch() {
  return recordingFetch(() => {
    throw new Error('no request expected');
  });
}

/** The error `resolveLoginTarget` throws for `platformEndpoint` with no flag or variable set. */
async function refusal(
  fetchImpl: typeof fetch,
  platformEndpoint = 'https://kici.corp.example',
): Promise<Error> {
  const err = await resolveLoginTarget({ platformEndpoint, env: {}, fetchImpl }).catch(
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(Error);
  return err as Error;
}

describe('resolveLoginTarget', () => {
  it('uses the hosted defaults when no Platform is named', async () => {
    const { calls, fetchImpl } = forbiddenFetch();
    const target = await resolveLoginTarget({ env: {}, fetchImpl });
    expect(target).toEqual(HOSTED_TARGET);
    expect(calls).toEqual([]);
  });

  it('treats the hosted host as the hosted default, whatever the scheme or case', async () => {
    const { calls, fetchImpl } = forbiddenFetch();
    // fails-when: an explicit hosted endpoint triggers discovery and a new CLI
    // needs the route deployed first
    // fails-when: the check compares full URLs, so http://api.kici.dev goes to discovery,
    // follows the redirect to the hosted Platform and is refused as the hosted issuer
    for (const platformEndpoint of [
      'https://api.kici.dev/',
      'https://api.kici.dev',
      'http://api.kici.dev',
      'https://API.kici.dev/',
      'HTTP://Api.Kici.Dev//',
      'https://api.kici.dev:443',
    ]) {
      const target = await resolveLoginTarget({ platformEndpoint, env: {}, fetchImpl });
      expect(target, platformEndpoint).toEqual(HOSTED_TARGET);
    }
    const fromEnv = await resolveLoginTarget({
      env: { KICI_PLATFORM_URL: 'http://api.kici.dev/' },
      fetchImpl,
    });
    expect(fromEnv.source).toBe(LoginTargetSource.enum.hosted_default);
    expect(calls).toEqual([]);
  });

  it.each([
    'https://api.kici.dev.evil.example',
    'https://evil-api.kici.dev',
    'http://api.kici.dev:8080',
    'https://api.kici.dev/prefix',
  ])('asks a host that only resembles the hosted one for its login settings: %s', async (url) => {
    const { calls, fetchImpl } = recordingFetch(() => json(PUBLISHED));
    // breaks-if-wrong: a look-alike host passes as hosted and skips discovery
    const target = await resolveLoginTarget({ platformEndpoint: url, env: {}, fetchImpl });
    expect(target.source).toBe(LoginTargetSource.enum.platform_published);
    expect(target.platformUrl).toBe(url);
    expect(calls).toEqual([`${url}${CLI_LOGIN_CONFIG_PATH}`]);
  });

  it('reads the issuer the named Platform publishes', async () => {
    const { calls, fetchImpl } = recordingFetch(() => json(PUBLISHED));
    const target = await resolveLoginTarget({
      platformEndpoint: 'https://kici.corp.example/',
      env: {},
      fetchImpl,
    });
    expect(target).toEqual({
      platformUrl: 'https://kici.corp.example',
      issuer: PUBLISHED.issuer,
      clientId: PUBLISHED.clientId,
      source: LoginTargetSource.enum.platform_published,
      extraScopes: [],
    });
    expect(calls).toEqual([`https://kici.corp.example${CLI_LOGIN_CONFIG_PATH}`]);
  });

  it('reads the issuer the Platform named in KICI_PLATFORM_URL publishes', async () => {
    const { calls, fetchImpl } = recordingFetch(() => json(PUBLISHED));
    const target = await resolveLoginTarget({
      env: { KICI_PLATFORM_URL: 'https://kici.corp.example' },
      fetchImpl,
    });
    expect(target.issuer).toBe(PUBLISHED.issuer);
    expect(target.source).toBe(LoginTargetSource.enum.platform_published);
    expect(calls).toEqual([`https://kici.corp.example${CLI_LOGIN_CONFIG_PATH}`]);
  });

  it('keeps a Platform path prefix in the request', async () => {
    const { calls, fetchImpl } = recordingFetch(() => json(PUBLISHED));
    await resolveLoginTarget({
      platformEndpoint: 'https://corp.example/kici',
      env: {},
      fetchImpl,
    });
    expect(calls).toEqual([`https://corp.example/kici${CLI_LOGIN_CONFIG_PATH}`]);
  });

  it('appends the scopes the named Platform publishes', async () => {
    const scoped = recordingFetch(() => json({ ...PUBLISHED, extraScopes: ['groups'] }));
    const target = await resolveLoginTarget({
      platformEndpoint: 'https://kici.corp.example',
      env: {},
      fetchImpl: scoped.fetchImpl,
    });
    expect(target.extraScopes).toEqual(['groups']);
    // breaks-if-wrong: Platforms that publish no scopes keep today's scope string
    const plain = recordingFetch(() => json(PUBLISHED));
    const without = await resolveLoginTarget({
      platformEndpoint: 'https://kici.corp.example',
      env: {},
      fetchImpl: plain.fetchImpl,
    });
    expect(without.extraScopes).toEqual([]);
  });

  it('KICI_OIDC_CLIENT_ID overrides the published client id', async () => {
    const { fetchImpl } = recordingFetch(() => json(PUBLISHED));
    const target = await resolveLoginTarget({
      platformEndpoint: 'https://kici.corp.example',
      env: { KICI_OIDC_CLIENT_ID: 'my-own-client' },
      fetchImpl,
    });
    expect(target.issuer).toBe(PUBLISHED.issuer);
    expect(target.clientId).toBe('my-own-client');
  });

  it('an explicit issuer keeps today’s resolution', async () => {
    const { calls, fetchImpl } = forbiddenFetch();
    // breaks-if-wrong: scripts that pass both flags must keep the Platform and
    // issuer they name, with no request
    const fromFlag = await resolveLoginTarget({
      platformEndpoint: 'https://kici.corp.example/',
      oidcIssuer: 'https://idp.corp.example/realms/x',
      env: {},
      fetchImpl,
    });
    expect(fromFlag).toEqual({
      platformUrl: 'https://kici.corp.example/',
      issuer: 'https://idp.corp.example/realms/x',
      clientId: PROD_OIDC_CLIENT_ID,
      source: LoginTargetSource.enum.explicit_issuer,
      extraScopes: [],
    });
    const fromEnv = await resolveLoginTarget({
      env: {
        KICI_PLATFORM_URL: 'https://kici.corp.example',
        KICI_OIDC_ISSUER: 'https://idp.corp.example/realms/y',
        KICI_OIDC_CLIENT_ID: 'env-client',
      },
      fetchImpl,
    });
    expect(fromEnv).toEqual({
      platformUrl: 'https://kici.corp.example',
      issuer: 'https://idp.corp.example/realms/y',
      clientId: 'env-client',
      source: LoginTargetSource.enum.explicit_issuer,
      extraScopes: [],
    });
    const flagBeatsEnv = await resolveLoginTarget({
      platformEndpoint: 'https://flag.corp.example',
      oidcIssuer: 'https://idp.corp.example/realms/flag',
      env: {
        KICI_PLATFORM_URL: 'https://env.corp.example',
        KICI_OIDC_ISSUER: 'https://idp.corp.example/realms/env',
      },
      fetchImpl,
    });
    expect(flagBeatsEnv.platformUrl).toBe('https://flag.corp.example');
    expect(flagBeatsEnv.issuer).toBe('https://idp.corp.example/realms/flag');
    expect(calls).toEqual([]);
  });

  it('an explicit issuer without a named Platform logs in to the hosted one', async () => {
    const { calls, fetchImpl } = forbiddenFetch();
    const target = await resolveLoginTarget({
      oidcIssuer: 'https://idp.corp.example/realms/x',
      env: {},
      fetchImpl,
    });
    expect(target.platformUrl).toBe(PROD_PLATFORM_URL);
    expect(target.source).toBe(LoginTargetSource.enum.explicit_issuer);
    expect(calls).toEqual([]);
  });

  it.each([
    PROD_OIDC_ISSUER,
    `${PROD_OIDC_ISSUER}/`,
    PROD_OIDC_ISSUER.replace('https://auth.kici.dev', 'https://AUTH.KICI.DEV'),
  ])('refuses a Platform that publishes the hosted identity provider: %s', async (issuer) => {
    const { fetchImpl } = recordingFetch(() => json({ issuer, clientId: 'kici-cli' }));
    // fails-when: a Platform other than the hosted one can send the CLI to sign in at the
    // hosted identity provider, then receive the hosted token in the exchange
    const err = await refusal(fetchImpl);
    expect(err.message).toContain(
      'The Platform at https://kici.corp.example publishes the hosted KiCI identity provider',
    );
    expect(err.message).toContain('--oidc-issuer');
  });

  it('accepts the hosted identity provider from the hosted Platform or an explicit issuer', async () => {
    const { calls, fetchImpl } = forbiddenFetch();
    // breaks-if-wrong: the hosted Platform and an explicit hosted issuer never go through
    // discovery, so the refusal must not reach them
    const hosted = await resolveLoginTarget({
      platformEndpoint: PROD_PLATFORM_URL,
      env: {},
      fetchImpl,
    });
    expect(hosted.issuer).toBe(PROD_OIDC_ISSUER);
    expect(hosted.source).toBe(LoginTargetSource.enum.hosted_default);
    const explicit = await resolveLoginTarget({
      platformEndpoint: 'https://kici.corp.example',
      env: { KICI_OIDC_ISSUER: PROD_OIDC_ISSUER },
      fetchImpl,
    });
    expect(explicit.issuer).toBe(PROD_OIDC_ISSUER);
    expect(explicit.source).toBe(LoginTargetSource.enum.explicit_issuer);
    expect(calls).toEqual([]);
  });

  it('refuses a Platform that publishes no login settings', async () => {
    const { fetchImpl } = recordingFetch(() =>
      json({ error: CliLoginConfigError.enum.login_not_configured }, 404),
    );
    const err = await refusal(fetchImpl);
    expect(err.message).toContain('publishes no login settings');
    expect(err.message).toContain('--oidc-issuer');
    expect(err.message).not.toContain('kici.dev');
  });

  it('refuses a Platform that answers its login settings with an error status', async () => {
    const { fetchImpl } = recordingFetch(() => new Response('upstream down', { status: 502 }));
    const err = await refusal(fetchImpl);
    expect(err.message).toContain('HTTP 502');
    expect(err.message).toContain('--oidc-issuer');
    expect(err.message).not.toContain('kici.dev');
  });

  it('refuses an unreachable Platform', async () => {
    const { fetchImpl } = recordingFetch(() => {
      throw new TypeError('fetch failed');
    });
    const err = await refusal(fetchImpl, 'http://127.0.0.1:14467');
    // fails-when: discovery failure falls back to the hosted issuer
    expect(err.message).toContain('Could not reach Platform at http://127.0.0.1:14467');
    expect(err.message).toContain('--oidc-issuer');
    expect(err.message).toContain('KICI_OIDC_ISSUER');
    expect(err.message).not.toContain('kici.dev');
  });

  it.each([
    [
      'a non-JSON body',
      () => new Response('<html>hi</html>', { status: 200 }),
      '(the body is not JSON)',
    ],
    ['an ftp issuer', () => json({ issuer: 'ftp://x', clientId: 'c' }), 'at issuer'],
    ['a missing client id', () => json({ issuer: 'https://x' }), 'at clientId'],
  ])('refuses an invalid login configuration: %s', async (_name, respond, reason) => {
    const { fetchImpl } = recordingFetch(respond);
    const err = await refusal(fetchImpl);
    expect(err.message).toContain('invalid login configuration');
    // fails-when: the error drops the reason the body was refused
    expect(err.message).toContain(reason);
    // fails-when: the multi-line schema report reaches the one-line CLI error
    expect(err.message).not.toMatch(/[\r\n]/);
    expect(err.message).not.toContain('auth.kici.dev');
  });

  it.each(['wss://api.kici.dev/ws', 'ws://h/ws'])(
    'refuses a WebSocket URL before any request: %s',
    async (platformEndpoint) => {
      const { calls, fetchImpl } = forbiddenFetch();
      const err = await refusal(fetchImpl, platformEndpoint);
      expect(err.message).toContain('WebSocket');
      expect(err.message).toContain('--platform-endpoint');
      expect(calls).toEqual([]);
    },
  );

  it('refuses a WebSocket URL from KICI_PLATFORM_URL, even with an explicit issuer', async () => {
    const { calls, fetchImpl } = forbiddenFetch();
    const pending = resolveLoginTarget({
      oidcIssuer: 'https://idp.corp.example/realms/x',
      env: { KICI_PLATFORM_URL: 'wss://kici.corp.example/ws' },
      fetchImpl,
    });
    await expect(pending).rejects.toThrow('WebSocket');
    await expect(pending).rejects.toThrow('KICI_PLATFORM_URL');
    expect(calls).toEqual([]);
  });

  it('refuses a Platform endpoint that is not an http(s) URL before any request', async () => {
    const { calls, fetchImpl } = forbiddenFetch();
    const err = await refusal(fetchImpl, 'kici.corp.example');
    expect(err.message).toContain('http:// or https://');
    expect(calls).toEqual([]);
  });

  it('treats an empty flag or variable as unset', async () => {
    const { calls, fetchImpl } = forbiddenFetch();
    const target = await resolveLoginTarget({
      platformEndpoint: '',
      oidcIssuer: '',
      env: { KICI_PLATFORM_URL: '', KICI_OIDC_ISSUER: '', KICI_OIDC_CLIENT_ID: '' },
      fetchImpl,
    });
    expect(target.source).toBe(LoginTargetSource.enum.hosted_default);
    expect(target.clientId).toBe(PROD_OIDC_CLIENT_ID);
    expect(calls).toEqual([]);
  });
});

describe('fetchCliLoginConfig', () => {
  it('returns the parsed login settings', async () => {
    const { calls, fetchImpl } = recordingFetch(() => json(PUBLISHED));
    await expect(fetchCliLoginConfig('https://kici.corp.example', fetchImpl)).resolves.toEqual(
      PUBLISHED,
    );
    expect(calls).toEqual([`https://kici.corp.example${CLI_LOGIN_CONFIG_PATH}`]);
  });
});

describe('fetchCliLoginConfig and a Platform that refuses a newer CLI', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('passes the refusal through, read once, with the Platform message', async () => {
    // fails-when: the catch wraps the refusal in "Could not reach Platform", so the user reads
    // a dropped connection instead of the Platform's message
    const fetchMock = vi.fn(async () =>
      json({ error: 'client_newer_than_platform', message: 'Upgrade it (test).' }, 409),
    );
    vi.stubGlobal('fetch', fetchMock);
    const err = await fetchCliLoginConfig('https://kici.corp.example').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ClientNewerThanPlatformError);
    expect((err as Error).message).toBe('Upgrade it (test).');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('a dropped connection is still "Could not reach Platform"', async () => {
    // breaks-if-wrong: the rethrow is for the refusal only
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('ECONNREFUSED');
      }),
    );
    await expect(fetchCliLoginConfig('https://kici.corp.example')).rejects.toThrow(
      /Could not reach Platform at https:\/\/kici\.corp\.example/,
    );
  });
});

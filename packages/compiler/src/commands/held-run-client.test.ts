import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../remote/config.js', () => ({
  loadGlobalConfig: vi.fn(),
}));

const errorOutput: string[] = [];
vi.mock('@kici-dev/core', () => ({
  logger: {
    info: vi.fn(),
    error: vi.fn((msg: string) => errorOutput.push(String(msg))),
    warn: vi.fn(),
    debug: vi.fn(),
  },
  toErrorMessage: (err: unknown) => (err instanceof Error ? err.message : String(err)),
}));

import { loadGlobalConfig } from '../remote/config.js';
import {
  resolveHeldRunContext,
  listHeldRunsForRun,
  HeldRunRequestError,
} from './held-run-client.js';

const mockedLoadConfig = vi.mocked(loadGlobalConfig);

/** A config missing exactly one of the three things the context needs. */
const partialConfigs = [
  { label: 'no token', config: { platformEndpoint: 'https://api.test', activeOrgId: 'org-1' } },
  { label: 'no endpoint', config: { pat: 'pat-token', activeOrgId: 'org-1' } },
  { label: 'no active org', config: { pat: 'pat-token', platformEndpoint: 'https://api.test' } },
];

beforeEach(() => {
  errorOutput.length = 0;
});

afterEach(() => vi.restoreAllMocks());

describe('resolveHeldRunContext', () => {
  it('resolves the endpoint, token and org from the config', async () => {
    mockedLoadConfig.mockResolvedValue({
      pat: 'pat-token',
      platformEndpoint: 'https://api.test',
      activeOrgId: 'org-1',
    } as never);
    expect(await resolveHeldRunContext()).toEqual({
      endpoint: 'https://api.test',
      token: 'pat-token',
      orgId: 'org-1',
    });
    expect(errorOutput).toEqual([]);
  });

  for (const { label, config } of partialConfigs) {
    it(`explains what is missing by default — ${label}`, async () => {
      mockedLoadConfig.mockResolvedValue(config as never);
      expect(await resolveHeldRunContext()).toBeNull();
      // `kici approve` depends on this surface, so it must say what to run.
      expect(errorOutput).toHaveLength(1);
      expect(errorOutput[0]).toMatch(/kici (login|org use)/);
    });

    it(`stays silent under quiet — ${label}`, async () => {
      mockedLoadConfig.mockResolvedValue(config as never);
      // `kici runs show` reads holds as optional detail on a run it can already
      // display, so an unresolvable context must not make it print an
      // authentication error for a command that worked.
      expect(await resolveHeldRunContext({ quiet: true })).toBeNull();
      expect(errorOutput).toEqual([]);
    });
  }
});

describe('listHeldRunsForRun', () => {
  const ctx = { endpoint: 'https://api.test', token: 't', orgId: 'org-1' };

  it('throws a permission-denied error on a 403', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ error: 'nope' }), { status: 403 })),
    );
    // The status is what lets `kici runs show` tell a caller who will never
    // have the data from one whose request merely failed this time.
    const err = await listHeldRunsForRun(ctx, 'r1').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HeldRunRequestError);
    expect((err as HeldRunRequestError).status).toBe(403);
    expect((err as HeldRunRequestError).isPermissionDenied).toBe(true);
  });

  it('throws a non-permission error on a 500', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('boom', { status: 500 })),
    );
    const err = await listHeldRunsForRun(ctx, 'r1').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HeldRunRequestError);
    expect((err as HeldRunRequestError).isPermissionDenied).toBe(false);
  });

  it('returns the held runs on success', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ heldRuns: [{ id: 'h1' }] }))),
    );
    expect(await listHeldRunsForRun(ctx, 'r1')).toEqual([{ id: 'h1' }]);
  });
});

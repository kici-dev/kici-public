import { describe, it, expect } from 'vitest';
import { DashboardClientError } from '../../remote/dashboard-client.js';
import { lookupTarget, redactCliConfig, withLookupTarget } from './cli-config.js';

// The shape `kici login` + `kici org use` write to ~/.kici/config.
const CONFIG = {
  platformEndpoint: 'https://api.kici.dev',
  oidcIssuer: 'https://auth.kici.dev',
  pat: 'kici_pat_0123abcd0123abcd0123abcd',
  patId: '6f1c2b0e-8a8d-4c3e-9a51-0d6c1f3e2a77',
  patExpiresAt: '2026-12-31T00:00:00.000Z',
  activeOrgId: 'org_acme',
  userEmail: 'dev@example.com',
  routingKey: 'github:42',
  defaultClusters: { org_acme: 'primary' },
};

describe('redactCliConfig', () => {
  it('keeps the fields that say where the CLI looks readable', () => {
    const out = redactCliConfig(CONFIG);
    // fails-when: platformEndpoint is '****' (the plain redactConfig output).
    expect(out.platformEndpoint).toBe('https://api.kici.dev');
    expect(out.oidcIssuer).toBe('https://auth.kici.dev');
    expect(out.activeOrgId).toBe('org_acme');
    expect(out.patExpiresAt).toBe('2026-12-31T00:00:00.000Z');
  });

  it('keeps every credential and personal field masked', () => {
    const out = redactCliConfig(CONFIG);
    // breaks-if-wrong: widening the allowlist to "every string" would leak these.
    // Positive control: the input really carries each value.
    expect(CONFIG.pat).not.toBe('****');
    expect(out.pat).toBe('****');
    expect(out.patId).toBe('****');
    expect(out.userEmail).toBe('****');
    expect(out.routingKey).toBe('****');
    expect(out.defaultClusters).toEqual({ org_acme: '****' });
  });

  it('masks a stale token key and keeps the orchestrator endpoint readable', () => {
    const out = redactCliConfig({
      endpoint: 'https://orch.example.com',
      token: 'legacy-api-key-value',
    });
    expect(out.endpoint).toBe('https://orch.example.com');
    expect(out.token).toBe('****');
  });

  it('keeps nested values masked even under a readable key name', () => {
    // A nested key that shares a readable name is not a top-level location field.
    const out = redactCliConfig({
      defaultClusters: { platformEndpoint: 'cluster-a', org_x: 'cluster-b' },
    });
    expect(out.defaultClusters).toEqual({ platformEndpoint: '****', org_x: '****' });
  });

  it('does not add a readable key the config does not carry', () => {
    const out = redactCliConfig({ pat: 'kici_pat_0123abcd0123abcd0123abcd' });
    expect(Object.keys(out)).toEqual(['pat']);
  });

  it('does not mutate its input', () => {
    const input = structuredClone(CONFIG);
    redactCliConfig(input);
    expect(input).toEqual(CONFIG);
  });
});

describe('lookupTarget', () => {
  it('resolves the Platform endpoint and the active org', () => {
    expect(lookupTarget(CONFIG)).toEqual({
      endpoint: 'https://api.kici.dev',
      orgId: 'org_acme',
    });
  });

  it('does not treat a direct-mode endpoint as the Platform URL', () => {
    // fails-when: lookupTarget falls back to `endpoint` — an orchestrator URL would be
    // named as the Platform the lookup searched.
    expect(
      lookupTarget({ endpoint: 'http://localhost:10143', activeOrgId: 'org_a' }),
    ).toBeUndefined();
  });

  it('uses platformEndpoint when both are set', () => {
    expect(
      lookupTarget({
        platformEndpoint: 'https://api.kici.dev',
        endpoint: 'https://orch.example.com',
        activeOrgId: 'org_a',
      })?.endpoint,
    ).toBe('https://api.kici.dev');
  });

  it('strips one trailing slash, as the client does before the request', () => {
    expect(
      lookupTarget({ platformEndpoint: 'https://api.kici.dev/', activeOrgId: 'org_a' })?.endpoint,
    ).toBe('https://api.kici.dev');
  });

  it('returns undefined when the CLI has no org or no endpoint', () => {
    // Never render "searched org undefined".
    expect(lookupTarget({ platformEndpoint: 'https://api.kici.dev' })).toBeUndefined();
    expect(lookupTarget({ activeOrgId: 'org_a' })).toBeUndefined();
    expect(lookupTarget(undefined)).toBeUndefined();
  });
});

describe('withLookupTarget', () => {
  const target = { endpoint: 'https://api.kici.dev', orgId: 'org_acme' };

  it('names the endpoint and org on a not-found error', () => {
    const err = withLookupTarget(
      new DashboardClientError('not_found', 'Run not found', 404),
      target,
    );
    // fails-when: the raw error is returned (the note reads just "Run not found").
    expect(err).toBeInstanceOf(DashboardClientError);
    expect((err as DashboardClientError).message).toBe(
      'Run not found (searched org org_acme on https://api.kici.dev)',
    );
    expect((err as DashboardClientError).kind).toBe('not_found');
    expect((err as DashboardClientError).status).toBe(404);
  });

  it('leaves every other error kind untouched', () => {
    // breaks-if-wrong: an auth failure must keep its own remedy text.
    const unauthorized = new DashboardClientError('unauthorized', 'Authentication failed.', 401);
    expect(withLookupTarget(unauthorized, target)).toBe(unauthorized);
    const plain = new Error('boom');
    expect(withLookupTarget(plain, target)).toBe(plain);
  });

  it('leaves a not-found error untouched when the target is unknown', () => {
    const err = new DashboardClientError('not_found', 'Run not found', 404);
    expect(withLookupTarget(err, undefined)).toBe(err);
  });
});

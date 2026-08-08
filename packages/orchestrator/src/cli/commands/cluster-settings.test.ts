import { describe, it, expect, vi, afterEach } from 'vitest';
import { Command } from 'commander';
import {
  buildClusterPatch,
  buildClusterReset,
  checkVerifiedIssuerPublishes,
  registerClusterSettingsCommands,
} from './cluster-settings.js';
import type { AdminApiClient } from '../api-client.js';

describe('buildClusterPatch', () => {
  it('maps kebab flags to camelCase fields and parses integers', () => {
    const patch = buildClusterPatch({ queueMaxDepth: '500', webhookDedupTtlMs: '3600000' });
    expect(patch).toEqual({ queueMaxDepth: 500, webhookDedupTtlMs: 3_600_000 });
  });

  it('parses the new fleet tunables', () => {
    const patch = buildClusterPatch({
      rerouteFlapGraceMs: '45000',
      cacheTtlDays: '14',
      agentTokenTtlMs: '1800000',
    });
    expect(patch).toEqual({
      rerouteFlapGraceMs: 45_000,
      cacheTtlDays: 14,
      agentTokenTtlMs: 1_800_000,
    });
  });

  it('builds a patch for --check-run-tracking-ttl-days', () => {
    const patch = buildClusterPatch({ checkRunTrackingTtlDays: '14' });
    expect(patch).toEqual({ checkRunTrackingTtlDays: 14 });
  });

  it('accepts 0 for --check-run-tracking-ttl-days (disables the sweep)', () => {
    // The knob's floor is 0, unlike every other numeric knob — 0 is the
    // documented way to turn the retention sweep off.
    const patch = buildClusterPatch({ checkRunTrackingTtlDays: '0' });
    expect(patch).toEqual({ checkRunTrackingTtlDays: 0 });
  });

  it('exits when no knob flag is provided', () => {
    const exit = vi.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('exit');
    });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(() => buildClusterPatch({})).toThrow('exit');
    exit.mockRestore();
  });

  it('accepts the dashboard verified-issuer text knob', () => {
    const patch = buildClusterPatch({ dashboardVerifiedIssuer: ' https://orch.example.com ' });
    expect(patch).toEqual({ dashboardVerifiedIssuer: 'https://orch.example.com' });
  });

  it('exits when the verified-issuer value is not an absolute http(s) URL', () => {
    const exit = vi.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('exit');
    });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(() => buildClusterPatch({ dashboardVerifiedIssuer: 'orch.example.com' })).toThrow(
      'exit',
    );
    exit.mockRestore();
  });

  it('exits when a value is below the knob floor', () => {
    const exit = vi.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('exit');
    });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(() => buildClusterPatch({ webhookDedupTtlMs: '500' })).toThrow('exit');
    exit.mockRestore();
  });
});

describe('buildClusterReset', () => {
  it('clears every knob to null when no flag is given', () => {
    const patch = buildClusterReset({});
    expect(patch.queueMaxDepth).toBeNull();
    expect(patch.eventLogMaxPayloadBytes).toBeNull();
    expect(patch.rerouteFlapGraceMs).toBeNull();
    expect(patch.agentTokenTtlMs).toBeNull();
    expect(patch.dashboardVerifiedIssuer).toBeNull();
    expect(patch.ownershipDbCheckTimeoutMs).toBeNull();
    expect(patch.checkRunTrackingTtlDays).toBeNull();
    expect(Object.keys(patch)).toHaveLength(18);
  });

  it('clears only the check-run tracking TTL when that flag is given', () => {
    const patch = buildClusterReset({ checkRunTrackingTtlDays: true });
    expect(patch).toEqual({ checkRunTrackingTtlDays: null });
  });

  it('clears only the flagged text knob', () => {
    const patch = buildClusterReset({ dashboardVerifiedIssuer: true });
    expect(patch).toEqual({ dashboardVerifiedIssuer: null });
  });

  it('clears only the flagged knobs', () => {
    const patch = buildClusterReset({ queueMaxDepth: true });
    expect(patch).toEqual({ queueMaxDepth: null });
  });
});

describe('registerClusterSettingsCommands', () => {
  afterEach(() => vi.restoreAllMocks());

  it('wires show / set / reset leaves', () => {
    const program = new Command();
    registerClusterSettingsCommands(program, () => ({}) as AdminApiClient);
    const group = program.commands.find((c) => c.name() === 'cluster-settings');
    expect(group).toBeDefined();
    const leaves = group!.commands.map((c) => c.name()).sort();
    expect(leaves).toEqual(['reset', 'set', 'show']);
  });
});

describe('checkVerifiedIssuerPublishes', () => {
  /** A fetch stub returning `status` and `body`, recording the URL it was given. */
  function fetchReturning(status: number, body: unknown, urls: string[] = []): typeof fetch {
    return (async (url: string) => {
      urls.push(String(url));
      return {
        ok: status >= 200 && status < 300,
        status,
        json: async () => body,
      };
    }) as unknown as typeof fetch;
  }

  const ENC_KEY = { kty: 'OKP', crv: 'X25519', x: 'e1', use: 'enc', kid: 'enc-1' };
  const SIG_KEY = { kty: 'EC', crv: 'P-256', x: 'a', y: 'b', use: 'sig', kid: 'kid-1' };

  it('accepts a JWKS carrying an enc key', async () => {
    const urls: string[] = [];
    const res = await checkVerifiedIssuerPublishes(
      'https://orch.example.com',
      fetchReturning(200, { keys: [SIG_KEY, ENC_KEY] }, urls),
    );
    expect(res).toEqual({ ok: true });
    // Reuses the one definition of the JWKS URL shape.
    expect(urls).toEqual(['https://orch.example.com/.well-known/jwks.json']);
  });

  it('rejects a JWKS with no enc key, naming the problem', async () => {
    const res = await checkVerifiedIssuerPublishes(
      'https://orch.example.com',
      fetchReturning(200, { keys: [SIG_KEY] }),
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toMatch(/no .*encryption key/i);
  });

  it('rejects a 503 and names the status', async () => {
    const res = await checkVerifiedIssuerPublishes(
      'https://orch.example.com',
      fetchReturning(503, { error: 'no_published_keys' }),
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toContain('503');
  });

  // It runs AFTER the setting has already been written, so it must never turn
  // a successful set into a crash.
  it('turns a network failure into a reason rather than throwing', async () => {
    const failing = (async () => {
      throw new Error('getaddrinfo ENOTFOUND orch.example.com');
    }) as unknown as typeof fetch;
    const res = await checkVerifiedIssuerPublishes('https://orch.example.com', failing);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toContain('ENOTFOUND');
  });

  it('turns malformed JSON into a reason rather than throwing', async () => {
    const badJson = (async () => ({
      ok: true,
      status: 200,
      json: async () => {
        throw new Error('Unexpected token');
      },
    })) as unknown as typeof fetch;
    const res = await checkVerifiedIssuerPublishes('https://orch.example.com', badJson);
    expect(res.ok).toBe(false);
  });
});

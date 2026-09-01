import { describe, it, expect, vi, afterEach } from 'vitest';
import { Command } from 'commander';
import {
  buildClusterPatch,
  buildClusterReset,
  checkVerifiedIssuerPublishes,
  deprecatedKnobWarnings,
  registerClusterSettingsCommands,
  unpairedEvalTimeoutWarnings,
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

  it('exits when a cache entry-count exceeds its ceiling, naming both bounds', () => {
    // The ceiling is a boot-safety bound: the LRU allocates its index arrays
    // eagerly from `max`, so an accepted over-ceiling value crashes the
    // orchestrator at construction — before the admin API this CLI talks to is
    // listening. Rejecting here is the good error message.
    const exit = vi.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('exit');
    });
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    for (const field of ['lockfileCacheMax', 'contentCacheMax', 'globalEvalCacheMax']) {
      err.mockClear();
      expect(() => buildClusterPatch({ [field]: '5000000000' })).toThrow('exit');
      expect(err.mock.calls[0]?.[0]).toContain('between 1 and 100000');
    }
    exit.mockRestore();
  });

  it('accepts a cache entry-count at the ceiling', () => {
    expect(buildClusterPatch({ lockfileCacheMax: '100000' })).toEqual({
      lockfileCacheMax: 100_000,
    });
    expect(buildClusterPatch({ contentCacheMax: '100000' })).toEqual({ contentCacheMax: 100_000 });
  });
});

describe('unpairedEvalTimeoutWarnings', () => {
  // The server rejects an inverted pair only when BOTH effective values are
  // stored; a NULL column means "the configured default applies" and the route
  // does not know that number. Setting one alone is exactly that blind spot.
  it('warns when only the wait ceiling is set', () => {
    const lines = unpairedEvalTimeoutWarnings({ globalEvalWaitTimeoutMs: 60_000 });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('--global-eval-round-timeout-ms');
  });

  it('warns about both unpaired axes when only the round budget is set', () => {
    // The round budget is one half of TWO ordered pairs: the wait ceiling must
    // stay above it, and the per-candidate budget must stay below it. Setting
    // it alone leaves both unchecked.
    const lines = unpairedEvalTimeoutWarnings({ globalEvalRoundTimeoutMs: 300_000 });
    expect(lines).toHaveLength(2);
    expect(lines.join('\n')).toContain('--global-eval-wait-timeout-ms');
    expect(lines.join('\n')).toContain('--global-eval-candidate-timeout-ms');
  });

  it('warns when only the candidate budget is set', () => {
    const lines = unpairedEvalTimeoutWarnings({ globalEvalCandidateTimeoutMs: 20_000 });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('--global-eval-round-timeout-ms');
    expect(lines[0]).toContain('suppress every other');
  });

  it('stays silent when a pair is set (the server checks it) or nothing is', () => {
    expect(
      unpairedEvalTimeoutWarnings({
        globalEvalRoundTimeoutMs: 120_000,
        globalEvalWaitTimeoutMs: 240_000,
        globalEvalCandidateTimeoutMs: 20_000,
      }),
    ).toEqual([]);
    expect(unpairedEvalTimeoutWarnings({ queueMaxDepth: 500 })).toEqual([]);
  });
});

describe('deprecatedKnobWarnings', () => {
  it('warns that the contributor-cache TTL is inert', () => {
    const lines = deprecatedKnobWarnings({ contributorCacheTtlMs: 900_000 });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('--contributor-cache-ttl-ms');
    expect(lines[0]).toContain('inert');
    expect(lines[0]).toContain('removed at v1.0.0');
  });

  it('says nothing for a live knob or for an empty patch', () => {
    expect(deprecatedKnobWarnings({ queueMaxDepth: 500 })).toEqual([]);
    expect(deprecatedKnobWarnings({})).toEqual([]);
  });

  it('says nothing when the knob is being cleared', () => {
    // `reset` sends null. Clearing an inert override is exactly what the
    // operator should do with it, so warning there would be backwards.
    expect(deprecatedKnobWarnings({ contributorCacheTtlMs: null })).toEqual([]);
  });
});

describe('the inert contributor-cache knob stays settable', () => {
  // Deprecate-then-remove: the column, the route field, and this flag are a
  // released operator surface, so a `set` must still build a patch rather than
  // failing. It is the WARNING that tells the operator the value is inert.
  it('still builds a patch', () => {
    expect(buildClusterPatch({ contributorCacheTtlMs: '900000' })).toEqual({
      contributorCacheTtlMs: 900_000,
    });
  });

  it('still clears with reset', () => {
    expect(buildClusterReset({ contributorCacheTtlMs: true })).toEqual({
      contributorCacheTtlMs: null,
    });
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
    expect(patch.unroutableGraceMs).toBeNull();
    expect(patch.ingestOverflowClaimTimeoutMs).toBeNull();
    expect(patch.lockfileCacheMax).toBeNull();
    expect(patch.contentCacheMaxBytes).toBeNull();
    expect(patch.globalEvalRoundTimeoutMs).toBeNull();
    expect(patch.globalEvalCacheMax).toBeNull();
    expect(patch.globalWorkflowsEnabled).toBeNull();
    expect(patch.scalerReapIntervalMs).toBeNull();
    expect(patch.scalerReapStrandedTimeoutMs).toBeNull();
    expect(patch.scalerReapReattemptIntervalMs).toBeNull();
    expect(patch.scalerClaimRetentionMs).toBeNull();
    expect(patch.scalerProvisionBackoffBaseMs).toBeNull();
    expect(patch.scalerProvisionBackoffMaxMs).toBeNull();
    expect(patch.scalerProvisionMaxConsecutiveFailures).toBeNull();
    // Count guard: a knob added to KNOBS/STRING_KNOBS/BOOLEAN_KNOBS without a
    // reset path (or vice versa) shows up here rather than as a knob an operator
    // cannot clear.
    expect(Object.keys(patch)).toHaveLength(38);
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

describe('boolean knobs', () => {
  it('buildClusterPatch parses --global-workflows-enabled true', () => {
    expect(buildClusterPatch({ globalWorkflowsEnabled: 'true' })).toEqual({
      globalWorkflowsEnabled: true,
    });
  });

  it('buildClusterPatch parses --global-workflows-enabled false as false, not as unset', () => {
    expect(buildClusterPatch({ globalWorkflowsEnabled: 'false' })).toEqual({
      globalWorkflowsEnabled: false,
    });
  });

  it('buildClusterPatch exits 1 on a non-boolean value', () => {
    const exit = vi.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('exit');
    });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(() => buildClusterPatch({ globalWorkflowsEnabled: 'yes' })).toThrow('exit');
    exit.mockRestore();
  });

  it('buildClusterReset --global-workflows-enabled clears only that knob', () => {
    expect(buildClusterReset({ globalWorkflowsEnabled: true })).toEqual({
      globalWorkflowsEnabled: null,
    });
  });

  it('an unflagged reset clears the boolean knob too', () => {
    expect(buildClusterReset({})).toHaveProperty('globalWorkflowsEnabled', null);
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

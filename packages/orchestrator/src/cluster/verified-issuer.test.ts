import { describe, expect, it } from 'vitest';
import {
  jwksUrlFor,
  resolveVerifiedIssuer,
  tryResolveVerifiedIssuer,
  verifiedIssuerCapabilityUpdate,
  type VerifiedIssuerReader,
} from './verified-issuer.js';

/**
 * Records the (column, fallback) pair so the test can assert no fallback is
 * passed, and the columns `tryGetString` was asked for separately.
 */
function readerReturning(value: string | null): {
  reader: VerifiedIssuerReader;
  calls: Array<[string, string | null]>;
  tryCalls: string[];
} {
  const calls: Array<[string, string | null]> = [];
  const tryCalls: string[] = [];
  return {
    calls,
    tryCalls,
    reader: {
      getString: async (column, fallback) => {
        calls.push([column, fallback]);
        return value;
      },
      tryGetString: async (column) => {
        tryCalls.push(column);
        return { ok: true, value };
      },
    } as VerifiedIssuerReader,
  };
}

/** A reader whose knob cannot be read at all (a sick DB). */
function unreadableReader(): VerifiedIssuerReader {
  return {
    getString: async (_column, fallback) => fallback,
    tryGetString: async () => ({ ok: false }),
  } as VerifiedIssuerReader;
}

describe('resolveVerifiedIssuer', () => {
  it('reads the cluster setting with NO fallback (the tier is explicit opt-in)', async () => {
    const { reader, calls } = readerReturning(null);
    await expect(resolveVerifiedIssuer(reader)).resolves.toBeNull();
    // A build-attestation issuer must never enable the Verified tier.
    expect(calls).toEqual([['dashboard_verified_issuer', null]]);
  });

  it('returns the configured origin when the operator opted in', async () => {
    const { reader } = readerReturning('https://orch.example.com');
    await expect(resolveVerifiedIssuer(reader)).resolves.toBe('https://orch.example.com');
  });
});

describe('tryResolveVerifiedIssuer', () => {
  it('reports the configured origin', async () => {
    const { reader, tryCalls } = readerReturning('https://orch.example.com');
    await expect(tryResolveVerifiedIssuer(reader)).resolves.toEqual({
      ok: true,
      issuer: 'https://orch.example.com',
    });
    expect(tryCalls).toEqual(['dashboard_verified_issuer']);
  });

  it('reports a genuine opt-out as a readable null', async () => {
    const { reader } = readerReturning(null);
    await expect(tryResolveVerifiedIssuer(reader)).resolves.toEqual({ ok: true, issuer: null });
  });

  it('reports unknown when the knob cannot be read', async () => {
    await expect(tryResolveVerifiedIssuer(unreadableReader())).resolves.toEqual({ ok: false });
  });
});

describe('verifiedIssuerCapabilityUpdate', () => {
  it('OMITS the key when the issuer is unknown', () => {
    const update = verifiedIssuerCapabilityUpdate({ ok: false });
    // `in`, not toEqual: vitest's toEqual ignores an explicitly-undefined
    // property, so `{ dashboardVerifiedIssuer: undefined }` would pass a
    // `toEqual({})` assertion — and spreading THAT into the merged capability
    // set overwrites the last known issuer with undefined, which is the exact
    // downgrade this helper exists to prevent.
    expect('dashboardVerifiedIssuer' in update).toBe(false);
    expect(Object.keys(update)).toEqual([]);
  });

  it('carries an explicit null when the operator really did opt out', () => {
    const update = verifiedIssuerCapabilityUpdate({ ok: true, issuer: null });
    expect('dashboardVerifiedIssuer' in update).toBe(true);
    expect(update.dashboardVerifiedIssuer).toBeNull();
  });

  it('carries the origin when the tier is enabled', () => {
    expect(
      verifiedIssuerCapabilityUpdate({ ok: true, issuer: 'https://orch.example.com' }),
    ).toEqual({ dashboardVerifiedIssuer: 'https://orch.example.com' });
  });

  it('holds the last known issuer through an unreadable tick, and clears on a real opt-out', () => {
    // The mechanism, pinned directly: broadcastCapabilities merges its argument
    // into the stored set (`{ ...stored, ...updates }`), so an omitted key means
    // "unchanged" and a present null means "cleared".
    const stored = { dashboardVerifiedIssuer: 'https://orch.example.com' as string | null };
    expect({ ...stored, ...verifiedIssuerCapabilityUpdate({ ok: false }) }).toEqual({
      dashboardVerifiedIssuer: 'https://orch.example.com',
    });
    expect({ ...stored, ...verifiedIssuerCapabilityUpdate({ ok: true, issuer: null }) }).toEqual({
      dashboardVerifiedIssuer: null,
    });
  });
});

describe('jwksUrlFor', () => {
  it('appends the well-known path without doubling the slash', () => {
    expect(jwksUrlFor('https://orch.example.com')).toBe(
      'https://orch.example.com/.well-known/jwks.json',
    );
    expect(jwksUrlFor('https://orch.example.com///')).toBe(
      'https://orch.example.com/.well-known/jwks.json',
    );
  });
});

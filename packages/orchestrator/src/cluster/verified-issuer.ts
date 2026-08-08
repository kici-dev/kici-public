/**
 * Resolves the Verified-tier issuer: the origin a browser fetches the
 * orchestrator's dashboard-encryption key from directly, bypassing the hosted
 * control plane, so TLS to the customer's own domain is the trust root.
 *
 * The tier is explicit opt-in and has NO environment-variable fallback. In
 * particular `KICI_ORCHESTRATOR_PROVENANCE_ISSUER` (a build-attestation
 * setting) must not enable it: configuring attestations is not consent to a
 * different dashboard trust tier, and the Verified fetch is cross-origin, so
 * switching a cluster into it unasked would hard-block every encrypted write
 * whose browser cannot reach that origin.
 *
 * Every consumer resolves through this module — the capability broadcast via
 * `tryResolveVerifiedIssuer`, the CLI via `resolveVerifiedIssuer` — so the two
 * read the same setting and can never disagree about which tier is active.
 * They differ only in what a failed read reports: unknown, or the opt-out
 * default.
 */
import type { OrchCapabilities } from '@kici-dev/engine';
import type { ClusterSettingsReader } from './cluster-settings-reader.js';

export type VerifiedIssuerReader = Pick<ClusterSettingsReader, 'getString' | 'tryGetString'>;

/**
 * The opted-in verified issuer origin, or null when the tier is not enabled.
 *
 * Null is ambiguous here: an unreadable setting also lands on it, because the
 * underlying `getString` swallows a DB error and takes the fallback. Anything
 * that would ACT on the null — broadcasting a tier, choosing a key source —
 * must use {@link tryResolveVerifiedIssuer} instead, or a transient DB failure
 * silently downgrades the trust root. Only the CLI still reads through here,
 * where the surrounding command already fails loudly on an unreachable DB.
 */
export async function resolveVerifiedIssuer(reader: VerifiedIssuerReader): Promise<string | null> {
  return reader.getString('dashboard_verified_issuer', null);
}

/**
 * The verified issuer, or `{ ok: false }` when the setting could not be read.
 *
 * The distinction matters only here: everywhere else a missing knob means "take
 * the default", but this knob's default is the weaker Convenient tier, so
 * answering "unset" for a failed read silently moves the trust root back to the
 * hosted control plane. A caller that already knows the issuer holds it instead.
 */
export type VerifiedIssuerRead = { ok: true; issuer: string | null } | { ok: false };

/** Read the verified issuer, keeping a failed read distinct from an opt-out. */
export async function tryResolveVerifiedIssuer(
  reader: VerifiedIssuerReader,
): Promise<VerifiedIssuerRead> {
  const read = await reader.tryGetString('dashboard_verified_issuer');
  return read.ok ? { ok: true, issuer: read.value } : { ok: false };
}

/**
 * The capability patch a `VerifiedIssuerRead` should broadcast.
 *
 * `broadcastCapabilities` MERGES its argument into the stored set, so an
 * omitted key means "unchanged" and a present `null` means "the operator opted
 * out". An unknown read must therefore produce an object with no key at all —
 * not one whose value is `undefined`, which would still overwrite on spread.
 *
 * Extracted as a pure function because its only caller is a closure inside
 * server.ts's connection handler, which has no test seam.
 */
export function verifiedIssuerCapabilityUpdate(
  read: VerifiedIssuerRead,
): Partial<Pick<OrchCapabilities, 'dashboardVerifiedIssuer'>> {
  return read.ok ? { dashboardVerifiedIssuer: read.issuer } : {};
}

/** The JWKS document URL for an issuer origin. */
export function jwksUrlFor(issuer: string): string {
  return `${issuer.replace(/\/+$/, '')}/.well-known/jwks.json`;
}

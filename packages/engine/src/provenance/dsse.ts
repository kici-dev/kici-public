/**
 * DSSE (Dead Simple Signing Envelope) helpers for KiCI provenance.
 *
 * Provides the in-toto pre-authentication encoding (PAE) and the envelope
 * assembly used by the agent producer and the verifier. Pure byte / base64
 * assembly with no Node-only crypto, so this module stays browser-safe and is
 * exported at the subpath `@kici-dev/engine/provenance/dsse`.
 *
 * Spec reference: https://github.com/secure-systems-lab/dsse/blob/master/protocol.md
 */
import { z } from 'zod';

/** A single DSSE signature: a key id plus the base64 signature bytes. */
export const dsseSignatureSchema = z.object({ keyid: z.string(), sig: z.string() });
export type DsseSignature = z.infer<typeof dsseSignatureSchema>;

/** A DSSE envelope: the payload type, the base64 payload, and ≥1 signature. */
export const dsseEnvelopeSchema = z.object({
  payloadType: z.string(),
  payload: z.string(), // base64-encoded payload bytes
  signatures: z.array(dsseSignatureSchema).min(1),
});
export type DsseEnvelope = z.infer<typeof dsseEnvelopeSchema>;

/**
 * DSSE pre-authentication encoding: `"DSSEv1 <lenType> <type> <lenBody> <body>"`.
 * The length fields count bytes (UTF-8 for the type, raw bytes for the payload).
 * This is the exact byte sequence that gets signed and verified.
 */
export function dssePae(payloadType: string, payload: Uint8Array): Uint8Array {
  const enc = new TextEncoder();
  const typeBytes = enc.encode(payloadType);
  const prefix = enc.encode(`DSSEv1 ${typeBytes.length} ${payloadType} ${payload.length} `);
  const out = new Uint8Array(prefix.length + payload.length);
  out.set(prefix, 0);
  out.set(payload, prefix.length);
  return out;
}

/** Assemble a {@link DsseEnvelope} from the payload bytes + raw signature bytes. */
export function buildDsseEnvelope(
  payloadType: string,
  payloadBytes: Uint8Array,
  signatures: { keyid: string; sig: Uint8Array }[],
): DsseEnvelope {
  return {
    payloadType,
    payload: Buffer.from(payloadBytes).toString('base64'),
    signatures: signatures.map((s) => ({
      keyid: s.keyid,
      sig: Buffer.from(s.sig).toString('base64'),
    })),
  };
}

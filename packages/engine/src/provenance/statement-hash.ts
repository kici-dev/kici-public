/**
 * Lowercase-hex SHA-256 of the DSSE statement payload bytes.
 *
 * A deferred OIDC mint carries this hash as a claim, so the identity cannot be
 * re-bound to a different frozen statement at retry time.
 *
 * Not a substitute for the build-context cross-check: the verifier requires
 * BOTH for a non-live origin — the hash proves the statement was not swapped,
 * the cross-check proves it agrees with the run the token names.
 *
 * Browser-safe (`crypto.subtle` only), so the dashboard and CLI verifier can
 * recompute it.
 */
export async function computeStatementHash(payload: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', payload as BufferSource);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * Lowercase-hex SHA-256 of the DSSE statement payload bytes.
 *
 * One of the two bindings a deferred OIDC mint commits to: the later token
 * carries this hash as a claim, so the identity cannot be re-bound to a
 * different frozen statement at retry time.
 *
 * It is a binding, not a substitute for the build-context cross-check. The
 * verifier requires BOTH for a non-live origin — the hash proves the statement
 * has not been swapped, and the cross-check proves the statement agrees with
 * the run the token names. A hash-only rule verified a bundle whose statement
 * claimed a release SHA the build never touched.
 *
 * Browser-safe: `crypto.subtle` only, so the verifier (dashboard + CLI) can
 * recompute it.
 */
export async function computeStatementHash(payload: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', payload as BufferSource);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

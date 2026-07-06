/**
 * Lowercase-hex SHA-256 of the DSSE statement payload bytes. This is the binding
 * a deferred OIDC mint commits to (truth-contract property 2): the later token
 * carries this hash as a claim so the Platform identity cannot be re-bound to a
 * different frozen statement at retry time. Browser-safe: `crypto.subtle` only,
 * so the verifier (dashboard + CLI) can recompute it.
 */
export async function computeStatementHash(payload: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', payload as BufferSource);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

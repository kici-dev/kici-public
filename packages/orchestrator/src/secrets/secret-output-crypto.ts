/**
 * Seal / unseal helpers for `run_secret_outputs.encrypted_value`.
 *
 * The column holds a value the orchestrator re-encrypted under the master key
 * after opening the agent's ECDH envelope, so it is one of the master-key
 * wrapped stores and moves with every key rotation. Three call sites read it —
 * the upstream-output merge, the `needs:` inherited-secret reader, and the
 * dashboard reveal path — and each derived the key and named the AAD by hand.
 * Centralising both here keeps the AAD shape and the rotation grace window in
 * one place instead of three.
 */
import { decrypt, encrypt } from '@kici-dev/shared';

/** AAD binding a stored secret output to its run (AES-GCM authenticated data). */
export function secretOutputAad(runId: string): string {
  return `secret-output:${runId}`;
}

/** Seal a secret-output plaintext under the master key at `keyVersion`. */
export function sealSecretOutput(
  plaintext: string,
  masterKey: Buffer,
  runId: string,
  keyVersion = 1,
): { data: string; keyVersion: number } {
  return encrypt(plaintext, masterKey, keyVersion, secretOutputAad(runId));
}

/**
 * Unseal a stored secret output with the current master key, falling back to
 * the old key during a rotation grace window. Same dual-key pattern as
 * `PgSecretStore.decryptWithFallback`. Throws when neither key opens it.
 */
export function unsealSecretOutput(
  encryptedValue: string,
  runId: string,
  keys: { current: Buffer; old?: Buffer },
  keyVersion = 1,
): string {
  const value = { data: encryptedValue, keyVersion };
  const aad = secretOutputAad(runId);
  try {
    return decrypt(value, keys.current, aad);
  } catch (primaryErr) {
    if (!keys.old) throw primaryErr;
  }
  return decrypt(value, keys.old, aad);
}

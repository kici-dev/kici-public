import { encryptJson } from '@kici-dev/core';
import { loadLocalSecrets } from '../local-executor/secret-loader.js';

/**
 * Parse `--context ctx.key=value` flag values into a nested
 * `{ context: { key: value } }` map. The first `.` splits the context name
 * from `key=value`; the first `=` splits key from value (values may contain
 * `=`). Malformed entries (missing `.` or `=`, empty context/key) are skipped.
 */
export function parseContextFlags(
  flags: string[] | undefined,
): Record<string, Record<string, string>> {
  const contexts: Record<string, Record<string, string>> = {};
  for (const flag of flags ?? []) {
    const dotIndex = flag.indexOf('.');
    if (dotIndex === -1) continue;
    const contextName = flag.slice(0, dotIndex).trim();
    const rest = flag.slice(dotIndex + 1);
    const eqIndex = rest.indexOf('=');
    if (eqIndex === -1) continue;
    const key = rest.slice(0, eqIndex).trim();
    const value = rest.slice(eqIndex + 1).trim();
    if (!contextName || !key) continue;
    (contexts[contextName] ??= {})[key] = value;
  }
  return contexts;
}

/**
 * Load the developer's local secrets (same sources as `kici run local`: the
 * `.kici` secret files plus `--env` flat flags) and `--context` namespaced
 * flags, and encrypt them to the orchestrator's per-upload X25519 public key.
 * `--context` values override `.kici/.secrets` file contexts for the same key.
 * Returns the base64 ciphertext and the ephemeral CLI public key the
 * orchestrator needs to decrypt, or null when there is nothing to send.
 */
export async function buildEncryptedSecrets(
  kiciDir: string,
  envFlags: string[] | undefined,
  contextFlags: string[] | undefined,
  orchestratorPublicKeyB64: string,
): Promise<{ encryptedSecrets: string; cliPublicKey: string } | null> {
  const local = await loadLocalSecrets(kiciDir, envFlags);

  const contexts: Record<string, Record<string, string>> = {};
  for (const [ctxName, vals] of Object.entries(local.contexts)) {
    contexts[ctxName] = { ...vals };
  }
  for (const [ctxName, vals] of Object.entries(parseContextFlags(contextFlags))) {
    contexts[ctxName] = { ...(contexts[ctxName] ?? {}), ...vals };
  }

  const hasFlat = Object.keys(local.flat).length > 0;
  const hasContexts = Object.values(contexts).some((c) => Object.keys(c).length > 0);
  if (!hasFlat && !hasContexts) return null;

  const { ciphertextB64, senderPublicKeyB64 } = encryptJson(
    { flat: local.flat, contexts },
    Buffer.from(orchestratorPublicKeyB64, 'base64'),
  );
  return { encryptedSecrets: ciphertextB64, cliPublicKey: senderPublicKeyB64 };
}

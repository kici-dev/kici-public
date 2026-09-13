/**
 * `kici local trust-root <file>` — export the offline local dev plane's
 * dev-signed identity trust root as a self-contained `{ issuer, jwks }` file.
 *
 * The plane's dev identity mints tokens with issuer `kici-local` (clearly
 * non-prod). To self-test a dev-signed attestation offline, `kici
 * verify-attestation --trust-root <file>` needs the plane's public JWKS + its
 * issuer, supplied out-of-band. This command writes exactly the shape
 * `verify-attestation`'s `--trust-root` file path consumes.
 *
 * The exported issuer is the fixed sentinel `kici-local` — it can NEVER
 * masquerade as the prod issuer (`https://api.kici.dev`), so verifying the same
 * bundle against the default (prod) trust root still rejects structurally.
 */
import fs from 'node:fs';
import pc from 'picocolors';
import { logger } from '@kici-dev/core';
import { devIdentityPublicJwkFile } from '../local-plane/plane-manager.js';

/** The plane's fixed non-prod dev-identity issuer. */
const KICI_LOCAL_ISSUER = 'kici-local';

/**
 * Write the local dev plane's `{ issuer, jwks }` trust root to `outFile`.
 * Returns true on success.
 */
export async function localTrustRootCommand(outFile: string): Promise<boolean> {
  if (!outFile) {
    logger.error(
      pc.red('Error: an output file path is required (`kici local trust-root <file>`).'),
    );
    return false;
  }
  const pubFile = devIdentityPublicJwkFile();
  let pubJwk: Record<string, unknown>;
  try {
    pubJwk = JSON.parse(fs.readFileSync(pubFile, 'utf-8')) as Record<string, unknown>;
  } catch {
    logger.error(
      pc.red(
        'Error: no dev-signed identity found for the local plane. Boot the plane first ' +
          '(`kici local up`) so it generates + publishes its public key.',
      ),
    );
    return false;
  }

  const trustRoot = { issuer: KICI_LOCAL_ISSUER, jwks: { keys: [pubJwk] } };
  fs.writeFileSync(outFile, JSON.stringify(trustRoot, null, 2) + '\n');
  logger.info(
    `${pc.green('✓')} Wrote local dev trust root to ${pc.bold(outFile)} ` +
      pc.dim(`(issuer ${KICI_LOCAL_ISSUER} — NOT prod)`),
  );
  logger.info(
    pc.dim(
      `Verify a dev-signed bundle offline with:\n` +
        `  kici verify-attestation --bundle <bundle> --trust-root ${outFile}`,
    ),
  );
  return true;
}

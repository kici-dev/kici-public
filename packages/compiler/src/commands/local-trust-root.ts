/**
 * `kici local trust-root <file>`: export the offline local dev plane's identity
 * trust root as the `{ issuer, jwks }` file `kici verify-attestation
 * --trust-root` consumes, to self-test a dev-signed attestation offline.
 *
 * The issuer is the fixed sentinel `kici-local`, which can never masquerade as
 * a real orchestrator issuer, so verifying the same bundle against any other
 * trust root rejects structurally.
 */
import fs from 'node:fs';
import pc from 'picocolors';
import { logger } from '@kici-dev/core';
import { devIdentityPublicJwkFile } from '../local-plane/plane-manager.js';

const KICI_LOCAL_ISSUER = 'kici-local';

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

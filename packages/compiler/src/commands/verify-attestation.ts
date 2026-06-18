/**
 * `kici verify-attestation [artifact] --bundle <path|url> --trust-root <url|file>`
 *
 * Offline verification of a KiCI-signed provenance bundle: read the bundle,
 * resolve the trusted issuer + JWKS out-of-band (`--trust-root`), optionally
 * digest the artifact, and hand everything to the shared browser-safe
 * `verifyKiciBundle` core in `@kici-dev/engine`. The engine owns all crypto;
 * this command is the thin Node wrapper (fs / fetch / artifact digest / output).
 *
 * Returns a boolean (verified) so `cli.ts` can map it to an exit code (0/1).
 */
import { readFile } from 'node:fs/promises';
import { logger, sha256File, toErrorMessage } from '@kici-dev/core';
import pc from 'picocolors';
import { KICI_PROVENANCE_AUDIENCE } from '@kici-dev/engine/provenance/bundle';
import { verifyKiciBundle } from '@kici-dev/engine/provenance/verify';
import { resolveTrustRoot } from '../provenance-trust-root.js';

export interface VerifyAttestationOptions {
  /** Path or `http(s)` URL to the attestation bundle JSON. Required. */
  bundle?: string;
  /** Trusted issuer URL (online discovery) or a self-contained `{ issuer, jwks }` file. Required. */
  trustRoot?: string;
  /** Expected token audience (defaults to the KiCI provenance audience). */
  audience?: string;
  /** Emit the structured `VerifyResult` as JSON instead of human output. */
  json?: boolean;
}

export async function verifyAttestationCommand(
  artifact: string | undefined,
  options: VerifyAttestationOptions = {},
): Promise<boolean> {
  try {
    if (!options.bundle) {
      logger.error(pc.red('Error: --bundle <path|url> is required'));
      return false;
    }
    if (!options.trustRoot) {
      logger.error(pc.red('Error: --trust-root <url|file> is required'));
      return false;
    }

    const bundle = JSON.parse(await readBundle(options.bundle)) as unknown;
    const { issuer, jwks } = await resolveTrustRoot(options.trustRoot);
    const expectedDigest = artifact
      ? { alg: 'sha256', hex: await sha256File(artifact) }
      : undefined;

    const result = await verifyKiciBundle({
      bundle,
      jwks,
      expectedIssuer: issuer,
      expectedAudience: options.audience ?? KICI_PROVENANCE_AUDIENCE,
      expectedDigest,
    });

    if (options.json) {
      console.log(JSON.stringify(result, null, 2));
      return result.verified;
    }

    if (result.verified) {
      logger.info(`${pc.green('PASS')} provenance verified (issuer ${issuer})`);
      const c = result.claims ?? {};
      logger.info(
        pc.gray(
          `  repository=${c.repository} ref=${c.ref} sha=${c.sha}` +
            ` run=${c.kici_run_id} job=${c.kici_job_id}`,
        ),
      );
    } else {
      logger.error(`${pc.red('FAIL')} provenance NOT verified: ${result.failures.join(', ')}`);
    }
    return result.verified;
  } catch (error) {
    logger.error(pc.red(`Error: ${toErrorMessage(error)}`));
    return false;
  }
}

async function readBundle(bundlePathOrUrl: string): Promise<string> {
  if (/^https?:\/\//.test(bundlePathOrUrl)) {
    const res = await fetch(bundlePathOrUrl);
    if (!res.ok) throw new Error(`failed to fetch bundle: ${res.status}`);
    return res.text();
  }
  return readFile(bundlePathOrUrl, 'utf-8');
}

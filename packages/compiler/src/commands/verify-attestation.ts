/**
 * `kici verify-attestation [artifact] --bundle <path|url> [--trust-root <url|file>]`
 *
 * Offline verification of a KiCI-signed provenance bundle: read the bundle,
 * resolve the trusted issuer + JWKS out-of-band, optionally digest the artifact,
 * and hand everything to the shared browser-safe `verifyKiciBundle` core in
 * `@kici-dev/engine`. The engine owns all crypto; this command is the thin Node
 * wrapper (fs / fetch / artifact digest / output).
 *
 * `--trust-root` is optional: when omitted it defaults to the CONFIGURED
 * ORCHESTRATOR (its own `.well-known`), which now owns provenance signing — the
 * natural root of trust for a self-hosted customer. When no orchestrator is
 * configured it falls back to the hosted KiCI Platform's provenance issuer (for
 * historical Platform-signed bundles, which keep verifying forever). Pass
 * `--trust-root` to verify against a different environment or an offline
 * `{ issuer, jwks }` file (air-gap). The token `iss` is always pinned to the
 * trust root out-of-band — a bundle can never name its own trusted issuer.
 *
 * Returns a boolean (verified) so `cli.ts` can map it to an exit code (0/1).
 */
import { readFile } from 'node:fs/promises';
import { logger, sha256File, toErrorMessage } from '@kici-dev/core';
import pc from 'picocolors';
import { KICI_PROVENANCE_AUDIENCE } from '@kici-dev/engine/provenance/bundle';
import { verifyKiciBundle } from '@kici-dev/engine/provenance/verify';
import { resolveTrustRoot, type TrustRoot } from '../provenance-trust-root.js';
import { PROD_PROVENANCE_ISSUER } from '../remote/prod-defaults.js';
import { loadGlobalConfig } from '../remote/config.js';

export interface VerifyAttestationOptions {
  /** Path or `http(s)` URL to the attestation bundle JSON. Required. */
  bundle?: string;
  /**
   * Trusted issuer URL (online discovery) or a self-contained `{ issuer, jwks }`
   * file. Optional — defaults to the configured orchestrator, falling back to
   * the hosted KiCI Platform's provenance issuer when no orchestrator is
   * configured.
   */
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

    // Default trust root resolution order:
    //   1. explicit --trust-root
    //   2. the configured orchestrator (its own base URL → its .well-known), the
    //      natural root of trust for a self-hosted customer whose orchestrator now
    //      owns provenance signing
    //   3. the hosted KiCI Platform's provenance issuer, as a last-resort fallback
    //      for a CLI with no configured orchestrator
    const globalConfig = await loadGlobalConfig().catch(() => null);
    const configuredOrchestrator = globalConfig?.endpoint;
    const trustRoot = options.trustRoot ?? configuredOrchestrator ?? PROD_PROVENANCE_ISSUER;
    const usingDefault = !options.trustRoot;
    const usingConfiguredOrchestrator = usingDefault && !!configuredOrchestrator;
    if (usingDefault) {
      const which = usingConfiguredOrchestrator
        ? 'configured orchestrator'
        : 'hosted KiCI platform';
      logger.info(
        pc.gray(`Using default trust root ${trustRoot} (${which}; pass --trust-root to override)`),
      );
    }

    const bundle = JSON.parse(await readBundle(options.bundle)) as unknown;

    let resolved: TrustRoot;
    try {
      resolved = await resolveTrustRoot(trustRoot);
    } catch (error) {
      const msg = toErrorMessage(error);
      if (usingDefault && /\b503\b/.test(msg)) {
        const where = usingConfiguredOrchestrator
          ? `your configured orchestrator (${trustRoot})`
          : `the hosted KiCI platform (${trustRoot})`;
        logger.error(
          pc.red(
            `Error: build provenance signing is not enabled on ${where} yet ` +
              `(returned 503). Pass --trust-root to verify against another ` +
              `environment or an offline { issuer, jwks } file.`,
          ),
        );
        return false;
      }
      throw error;
    }
    const { issuer, jwks } = resolved;
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
      logger.info(pc.gray(`  origin org=${c.org_id ?? 'unknown'}`));
      if (c.source_origin === 'run-remote') {
        logger.info(
          pc.bold(
            pc.yellow(
              `  SOURCE: kici run remote (local working-tree overlay — repository/ref/sha are ` +
                `caller-supplied, not a triggered VCS commit)`,
            ),
          ),
        );
      } else {
        logger.info(pc.gray(`  source: ${c.source_origin ?? 'triggered'}`));
      }
      const origin = result.attestationOrigin ?? 'live';
      if (origin === 'deferred') {
        logger.info(
          pc.bold(
            pc.yellow(
              `  ATTESTATION: deferred — the build facts were sealed at build time; the identity ` +
                `token was minted later (after a transient Platform outage), bound to the frozen ` +
                `statement by hash.`,
            ),
          ),
        );
      } else if (origin === 'offline-backfill') {
        logger.info(
          pc.bold(
            pc.yellow(
              `  ATTESTATION: offline-backfill — the run was ingested while the Platform was down; ` +
                `its run/job rows were backfilled and the token minted later. The org id is the ` +
                `authoritative anchor; the temporal gap is disclosed.`,
            ),
          ),
        );
      }
      logger.info(
        pc.gray(
          `  repository=${c.repository} ref=${c.ref} sha=${c.sha}` +
            ` provider=${c.provider ?? 'unknown'} run=${c.kici_run_id} job=${c.kici_job_id}`,
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

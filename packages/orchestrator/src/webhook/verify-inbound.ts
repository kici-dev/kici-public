/**
 * Inbound webhook verification dispatcher.
 *
 * Single entry point used by the orchestrator's chunked webhook.relay handler
 * to decide whether an inbound webhook is trusted before it enters the normal
 * processing pipeline. Dispatches by routing-key prefix to the appropriate
 * provider verification path:
 *
 * - `github:*`  -> reads the webhook secret from PgSecretStore at scope
 *                  `__source__/<sourceId>` and runs engine `verifySignature`
 *                  against the inbound `x-hub-signature-256` header (or the
 *                  signature header forwarded from Platform).
 * - `generic:*` -> looks up the source via GenericSourceManager, parses
 *                  `verification_method` + `verification_config`, and runs
 *                  the corresponding HMAC / bearer / IP-allowlist check via
 *                  `verifyGenericWebhook`.
 *
 * All four `WebhookRelayResult` outcomes are produced here:
 * - `accepted` when the source exists and the inbound signature/method passes.
 * - `rejected_signature` when the source exists but the signature does not match
 *   any rotation secret (or method-specific check fails).
 * - `rejected_unknown_source` when no row exists for the routing key (deleted,
 *   never created, or the prefix is for a provider that is not yet implemented).
 * - `rejected_misconfigured` when the source exists but its server-side state
 *   prevents verification (no secret stored, malformed verification_config JSON,
 *   etc). Operators should see this in metrics and fix the source config.
 *
 * The `reason` string returned alongside each rejection is non-secret-bearing
 * (no HMAC keys, bearer tokens, computed signatures); it is safe to surface in
 * `webhook.ack` reason field and in dashboards.
 */

import type { Kysely } from 'kysely';
import { createLogger, toErrorMessage } from '@kici-dev/shared';
import { verifySignature } from '@kici-dev/engine/webhook/signature';
import type { WebhookRelayResult } from '@kici-dev/engine';
import type { Database } from '../db/types.js';
import type { PgSecretStore } from '../secrets/pg-secret-store.js';
import type { GenericSourceManager } from './generic-sources.js';
import {
  verifyGenericWebhook,
  type VerificationConfig,
  type VerificationMethod,
} from '../providers/generic/verification.js';

const logger = createLogger({ prefix: 'verify-inbound' });

/** Fixed org_id for source secrets in PgSecretStore (matches SourceStore). */
const SOURCE_ORG_ID = '__system__';

/** Default GitHub-style signature header. */
const DEFAULT_GITHUB_SIGNATURE_HEADER = 'x-hub-signature-256';

/** Verification result + non-secret-bearing diagnostic for the orchestrator ACK. */
export interface VerifyOutcome {
  result: WebhookRelayResult;
  reason?: string;
}

/** Inputs the orchestrator-side handler hands to the dispatcher. */
export interface VerifyInboundInput {
  /** Routing key including provider prefix (`github:<appId>`, `generic:<orgId>:<sourceId>`, ...). */
  routingKey: string;
  /** Reassembled raw body bytes from the chunked relay stream. */
  body: Buffer;
  /** Lowercased headers Platform forwarded for this inbound webhook. */
  headers: Record<string, string>;
  /**
   * Inbound HTTP signature header NAME (lowercased), e.g. `x-hub-signature-256`.
   * Null when the inbound HTTP request had no signature header at all (some
   * generic verification methods do not need it; HMAC paths reject in that case).
   */
  signatureHeaderName: string | null;
  /** Inbound HTTP signature header VALUE (the claimed signature). */
  signatureHeader: string | null;
  /** Inbound HTTP request client IP, for IP-allowlist verification. */
  clientIp: string | null;
}

/** Dependencies the dispatcher reads from. */
export interface VerifyInboundDeps {
  /** Kysely DB handle for `sources` table lookups (github sources). */
  db: Kysely<Database>;
  /** Encrypted secret store for reading webhook secrets at `__source__/<sourceId>`. */
  secretStore: PgSecretStore;
  /** Manager for `generic_webhook_sources` rows. */
  genericSourceManager: GenericSourceManager;
}

/**
 * Run inbound verification for one webhook.
 *
 * Pure-ish: reads from the DB + secret store, but never throws — every error
 * path collapses into a `WebhookRelayResult`. The orchestrator handler is
 * waiting on a 5 s ACK budget and must not block on an exception.
 */
export async function verifyInboundWebhook(
  deps: VerifyInboundDeps,
  input: VerifyInboundInput,
): Promise<VerifyOutcome> {
  const { routingKey } = input;

  if (routingKey.startsWith('github:')) {
    return verifyGithub(deps, input);
  }
  if (routingKey.startsWith('generic:')) {
    return verifyGeneric(deps, input);
  }

  logger.warn('Unknown routing-key prefix', { routingKey });
  return {
    result: 'rejected_unknown_source',
    reason: `provider not implemented for routing key prefix`,
  };
}

/**
 * GitHub App webhook verification.
 *
 * Looks up the source by routing key, reads its webhook secret(s) from
 * PgSecretStore, and runs `verifySignature` from the engine. Supports
 * multi-secret rotation via `getGithubWebhookSecrets` returning an array;
 * any matching rotation secret accepts.
 */
async function verifyGithub(
  deps: VerifyInboundDeps,
  input: VerifyInboundInput,
): Promise<VerifyOutcome> {
  const { db, secretStore } = deps;
  const { routingKey, body, headers, signatureHeader, signatureHeaderName } = input;

  const source = await db
    .selectFrom('sources')
    .select(['id'])
    .where('routing_key', '=', routingKey)
    .executeTakeFirst();

  if (!source) {
    return {
      result: 'rejected_unknown_source',
      reason: 'no source row for routing key',
    };
  }

  let secrets: string[];
  try {
    secrets = await getGithubWebhookSecrets(secretStore, source.id);
  } catch (err) {
    logger.error('Failed to read webhook secret from PgSecretStore', {
      routingKey,
      sourceId: source.id,
      error: toErrorMessage(err),
    });
    return {
      result: 'rejected_misconfigured',
      reason: 'failed to read webhook secret from secret store',
    };
  }

  if (secrets.length === 0) {
    return {
      result: 'rejected_misconfigured',
      reason: 'no webhook secret stored for source',
    };
  }

  // GitHub webhooks ALWAYS send x-hub-signature-256. If Platform forwarded a
  // request without one, reject.
  const headerName = (signatureHeaderName ?? DEFAULT_GITHUB_SIGNATURE_HEADER).toLowerCase();
  const sig = signatureHeader ?? headers[headerName];
  if (!sig) {
    return {
      result: 'rejected_signature',
      reason: `missing signature header ${headerName}`,
    };
  }

  const bodyText = body.toString('utf8');
  for (const secret of secrets) {
    if (verifySignature(bodyText, sig, secret)) {
      return { result: 'accepted' };
    }
  }

  return {
    result: 'rejected_signature',
    reason: `no rotation secret matched ${headerName}`,
  };
}

/**
 * Generic webhook verification.
 *
 * Looks up the source row in `generic_webhook_sources`, parses the stored
 * `verification_config` JSON into a discriminated `VerificationConfig` (using
 * `verification_method` as the discriminator), and runs the appropriate check
 * via the existing `verifyGenericWebhook` helper.
 *
 * For HMAC sources, the secret lives inside `verification_config.secret`
 * (encrypted at rest by the row owner; never sent to Platform).
 */
async function verifyGeneric(
  deps: VerifyInboundDeps,
  input: VerifyInboundInput,
): Promise<VerifyOutcome> {
  const { genericSourceManager } = deps;
  const { routingKey, body, headers, clientIp } = input;

  const source = await genericSourceManager.getByRoutingKey(routingKey);
  if (!source) {
    return {
      result: 'rejected_unknown_source',
      reason: 'no generic_webhook_sources row for routing key',
    };
  }

  let config: VerificationConfig;
  try {
    config = parseGenericVerificationConfig(
      source.verification_method as VerificationMethod,
      source.verification_config,
    );
  } catch (err) {
    logger.error('Malformed verification_config JSON', {
      routingKey,
      method: source.verification_method,
      error: toErrorMessage(err),
    });
    return {
      result: 'rejected_misconfigured',
      reason: 'malformed verification_config',
    };
  }

  const bodyText = body.toString('utf8');
  const ok = verifyGenericWebhook(bodyText, headers, config, clientIp ?? undefined);

  if (ok) {
    return { result: 'accepted' };
  }

  return {
    result: 'rejected_signature',
    reason: `verification_method=${config.method} did not pass`,
  };
}

/**
 * Read all rotation webhook secrets for a github source from PgSecretStore.
 *
 * Today PgSecretStore stores a single `webhookSecret` key per source scope, so
 * this returns either an empty array (no secret stored) or a single-element
 * array. Returning an array keeps the caller's loop ready for future rotation
 * support (e.g. `webhookSecret_next` during a rolling rotation window) without
 * a second redesign.
 */
async function getGithubWebhookSecrets(
  secretStore: PgSecretStore,
  sourceId: string,
): Promise<string[]> {
  const scope = `__source__/${sourceId}`;
  const secrets = await secretStore.getSecrets(SOURCE_ORG_ID, scope);
  if (secrets.webhookSecret) {
    return [secrets.webhookSecret];
  }
  return [];
}

/**
 * Parse the row's `verification_method` + `verification_config` JSON into the
 * orchestrator's discriminated `VerificationConfig` union. Methods that don't
 * have a stored config (`none`) collapse to a single-key object.
 *
 * Throws if `verification_config` is malformed JSON or if a required field is
 * missing for the selected method (the caller maps the throw to
 * `rejected_misconfigured`).
 */
function parseGenericVerificationConfig(
  method: VerificationMethod,
  rawConfig: string | Record<string, unknown>,
): VerificationConfig {
  // Postgres JSONB columns come back from the `pg` driver as already-parsed JS
  // objects, but the column type was historically declared as `string` (the
  // INSERT path stringifies via JSON.stringify). Tolerate both shapes so the
  // caller doesn't have to know about driver-side parsing.
  const parsed: Record<string, unknown> =
    typeof rawConfig === 'string' ? (JSON.parse(rawConfig) as Record<string, unknown>) : rawConfig;

  switch (method) {
    case 'hmac_sha256': {
      const secret = parsed.secret;
      if (typeof secret !== 'string' || secret.length === 0) {
        throw new Error('hmac_sha256 verification_config missing string secret');
      }
      const headerName = typeof parsed.headerName === 'string' ? parsed.headerName : undefined;
      return headerName
        ? { method: 'hmac_sha256', secret, headerName }
        : { method: 'hmac_sha256', secret };
    }
    case 'bearer_token': {
      const token = parsed.token;
      if (typeof token !== 'string' || token.length === 0) {
        throw new Error('bearer_token verification_config missing string token');
      }
      const headerName = typeof parsed.headerName === 'string' ? parsed.headerName : undefined;
      return headerName
        ? { method: 'bearer_token', token, headerName }
        : { method: 'bearer_token', token };
    }
    case 'ip_allowlist': {
      const allowlist = parsed.allowlist;
      if (!Array.isArray(allowlist) || !allowlist.every((x) => typeof x === 'string')) {
        throw new Error('ip_allowlist verification_config missing string[] allowlist');
      }
      return { method: 'ip_allowlist', allowlist: allowlist as string[] };
    }
    case 'none':
      return { method: 'none' };
  }
}

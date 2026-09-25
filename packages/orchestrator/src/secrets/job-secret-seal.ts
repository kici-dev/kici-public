/**
 * Seal / unseal the secret fields of a job that waits in the orchestrator
 * database: a queued `dispatch_queue` row, a `pending_job_contexts` row, and a
 * held run's `pending_workflow_contexts` row.
 *
 * The fields are encrypted under the orchestrator master key with the same
 * AES-256-GCM helpers and dual-key fallback as `run_secret_outputs`
 * (`secret-output-crypto.ts`), bound to the run by the AAD. The ciphertext sits
 * in each table's `sealed_secrets` column; the plain JSON column keeps every
 * other field.
 *
 * The keys are resolved once at boot and registered here with
 * {@link configureJobSecretSealing}, because the three stores are written from
 * module-level functions and from the job queue alike. With no master key
 * configured, the fields stay in the plain JSON column, as they did before this
 * module existed, and one warning names the setting that turns sealing on.
 *
 * A row written before sealing existed has a NULL `sealed_secrets` and its
 * secrets in the plain column; it reads back unchanged.
 */
import { createLogger, decrypt, encrypt, toErrorMessage } from '@kici-dev/shared';
import type { ResolvedMasterKeys } from './config.js';

const logger = createLogger({ prefix: 'job-secret-seal' });

/** The job-config fields that carry secret material. */
export const SEALED_JOB_CONFIG_KEYS = [
  'secrets',
  'namespacedSecrets',
  'installEnvSecrets',
  'containerRegistryAuth',
  // Each entry carries the registry's auth token.
  'npmRegistries',
  // Opens a `kici run` overlay tarball.
  'orchestratorPrivateKey',
] as const;

/** The key version every seal is written at. The AAD, not the version, binds a value. */
export const JOB_SECRETS_KEY_VERSION = 1;

/**
 * Thrown when a sealed value cannot be opened: it was sealed with a master key
 * this orchestrator does not hold. During a rolling key rotation that is a
 * coordinator not yet restarted with the new key; the message names the fix.
 */
export class JobSecretsUnsealError extends Error {
  constructor(runId: string, cause: string) {
    super(
      `the secrets of a stored job of run ${runId} are sealed with a master key this ` +
        `orchestrator does not hold — finish the key rotation on every coordinator (${cause})`,
    );
    this.name = 'JobSecretsUnsealError';
  }
}

/** `undefined`: never configured (a test or an embedder); `null`: no master key. */
let sealingKeys: ResolvedMasterKeys | null | undefined;

/**
 * Register the master keys the stores seal with. `null` keeps the fields in
 * plaintext and logs the one warning that names the setting.
 */
export function configureJobSecretSealing(keys: ResolvedMasterKeys | null): void {
  sealingKeys = keys;
  if (keys === null) {
    logger.warn(
      'KICI_SECRET_KEY is not set: the secrets of queued and waiting jobs are stored ' +
        'unencrypted in the orchestrator database. Set KICI_SECRET_KEY (or ' +
        'KICI_SECRET_KEY_FILE) to encrypt them with the orchestrator master key.',
    );
  }
}

/** The AAD a stored job's sealed secrets are bound to. */
export function jobSecretsAad(runId: string): string {
  return `job-secrets:${runId}`;
}

/** Seal `value` for `runId`; `null` when no master key is configured. */
export function sealJobSecretValue(runId: string, value: unknown): string | null {
  if (!sealingKeys) return null;
  return encrypt(
    JSON.stringify(value),
    sealingKeys.current,
    JOB_SECRETS_KEY_VERSION,
    jobSecretsAad(runId),
  ).data;
}

/** Open a value {@link sealJobSecretValue} sealed, with the old key as fallback. */
export function unsealJobSecretValue(runId: string, sealed: string): unknown {
  // fails-when: a sealed row is read on an orchestrator that has no master key
  // breaks-if-wrong: a row sealed while a master key is configured must open under that key
  if (!sealingKeys) throw new JobSecretsUnsealError(runId, 'no master key is configured');
  const value = { data: sealed, keyVersion: JOB_SECRETS_KEY_VERSION };
  const aad = jobSecretsAad(runId);
  try {
    return JSON.parse(decrypt(value, sealingKeys.current, aad));
  } catch (primaryErr) {
    if (!sealingKeys.old) throw new JobSecretsUnsealError(runId, toErrorMessage(primaryErr));
  }
  try {
    return JSON.parse(decrypt(value, sealingKeys.old, aad));
  } catch (err) {
    throw new JobSecretsUnsealError(runId, toErrorMessage(err));
  }
}

/**
 * Split a job config into what is stored in the plain column and the sealed
 * secret fields. With nothing to seal, or no master key, the config is
 * returned as is and `sealed` is null.
 */
export function sealJobConfig(
  runId: string,
  jobConfig: Record<string, unknown>,
): { jobConfig: Record<string, unknown>; sealed: string | null } {
  const secret: Record<string, unknown> = {};
  const rest: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(jobConfig)) {
    if ((SEALED_JOB_CONFIG_KEYS as readonly string[]).includes(key)) secret[key] = value;
    else rest[key] = value;
  }
  if (Object.keys(secret).length === 0) return { jobConfig, sealed: null };
  const sealed = sealJobSecretValue(runId, secret);
  // breaks-if-wrong: an orchestrator with no master key keeps storing the fields in plaintext
  if (sealed === null) return { jobConfig, sealed: null };
  return { jobConfig: rest, sealed };
}

/** The job config with its sealed secret fields merged back. A null `sealed` returns it as is. */
export function unsealJobConfig(
  runId: string,
  jobConfig: Record<string, unknown>,
  sealed: string | null | undefined,
): Record<string, unknown> {
  if (sealed == null) return jobConfig;
  const secret = unsealJobSecretValue(runId, sealed) as Record<string, unknown>;
  return { ...jobConfig, ...secret };
}

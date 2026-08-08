import { z } from 'zod';
import { AwsKmsSigner } from './aws-kms-signer.js';
import { CommandSigner } from './command-signer.js';
import type { Signer } from './signer.js';

/** Custody backend for the orchestrator provenance signing key. */
export const OrchestratorSignerKind = z.enum(['db', 'aws-kms', 'command']);
export type OrchestratorSignerKind = z.infer<typeof OrchestratorSignerKind>;

/** The config slice the signer factory reads (subset of the orchestrator config). */
export interface OrchestratorSignerConfig {
  /** When set, provenance signing is ON (the issuer identity). */
  provenanceSigningIssuer?: string;
  /** Custody kind; defaults to `db` when signing is on. */
  provenanceSignerKind?: string;
  provenanceKmsKeyArn?: string;
  provenanceKmsRegion?: string;
  provenanceKmsAccessKeyId?: string;
  provenanceKmsSecretAccessKey?: string;
  provenanceSignerCommand?: string;
}

/** True iff orchestrator-owned provenance signing is configured (issuer set). */
export function isProvenanceSigningEnabled(cfg: OrchestratorSignerConfig): boolean {
  return Boolean(cfg.provenanceSigningIssuer);
}

/** Resolve the configured custody kind (defaulting to `db`). Throws on an invalid value. */
export function resolveSignerKind(cfg: OrchestratorSignerConfig): OrchestratorSignerKind {
  return OrchestratorSignerKind.parse(cfg.provenanceSignerKind ?? 'db');
}

/**
 * Build a NON-`db` (external-custody) signer from config. Returns null for `db`
 * custody (whose generate-or-load lives in the boot reconcile, since the private
 * key is created + persisted in the DB) and null when signing is off. Throws
 * when an external kind is selected but its required config is incomplete.
 */
export async function buildExternalSigner(cfg: OrchestratorSignerConfig): Promise<Signer | null> {
  if (!isProvenanceSigningEnabled(cfg)) return null;
  const kind = resolveSignerKind(cfg);
  if (kind === OrchestratorSignerKind.enum.db) return null;

  if (kind === OrchestratorSignerKind.enum['aws-kms']) {
    if (
      !cfg.provenanceKmsKeyArn ||
      !cfg.provenanceKmsRegion ||
      !cfg.provenanceKmsAccessKeyId ||
      !cfg.provenanceKmsSecretAccessKey
    ) {
      throw new Error(
        'aws-kms provenance signer requires KICI_ORCHESTRATOR_KMS_KEY_ARN, _REGION, _ACCESS_KEY_ID and _SECRET_ACCESS_KEY',
      );
    }
    return AwsKmsSigner.fromCredentials({
      keyArn: cfg.provenanceKmsKeyArn,
      region: cfg.provenanceKmsRegion,
      accessKeyId: cfg.provenanceKmsAccessKeyId,
      secretAccessKey: cfg.provenanceKmsSecretAccessKey,
    });
  }

  // command
  if (!cfg.provenanceSignerCommand) {
    throw new Error('command provenance signer requires KICI_ORCHESTRATOR_SIGNER_COMMAND');
  }
  return CommandSigner.create({ command: cfg.provenanceSignerCommand });
}

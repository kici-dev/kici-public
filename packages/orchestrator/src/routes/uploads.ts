/**
 * Test-run upload provisioning.
 *
 * Mints an upload record and a presigned PUT URL + ephemeral X25519 public key
 * for the overlay tarball. The developer encrypts the tarball with the returned
 * public key and PUTs it directly to the object store; a test trigger then
 * references the upload id. This is invoked by the Platform-first
 * `test.relay.uploads.init` relay handler — the developer never reaches the
 * orchestrator's HTTP API directly.
 */

import { randomUUID, generateKeyPairSync } from 'node:crypto';
import { createLogger } from '@kici-dev/shared';
import type { Kysely } from 'kysely';
import type { Database } from '../db/types.js';
import type { CacheStorage } from '../storage/types.js';

const logger = createLogger({ prefix: 'uploads' });

/**
 * Sanitize a routing key for use in S3 storage paths.
 * Replaces characters that are problematic in S3 keys.
 */
function sanitizeRoutingKey(routingKey: string): string {
  return routingKey.replace(/[^a-zA-Z0-9_-]/g, '_');
}

/** Parameters for {@link initTestUpload}. */
export interface InitTestUploadParams {
  routingKey: string;
  sha?: string;
  fileCount?: number;
  compressedSize?: number;
  /** PAT/actor identity that owns this upload, written to `test_uploads.created_by`. */
  createdBy?: string | null;
  /**
   * When true, presign with the host-facing internal endpoint. When false (the
   * Platform-relayed path), presign with the external/dev-reachable endpoint so
   * a developer on a different network can PUT directly to the object store.
   */
  internal?: boolean;
}

/** Result of {@link initTestUpload}. */
export interface InitTestUploadResult {
  uploadId: string;
  signedUrl: string;
  publicKey: string;
  expiresIn: number;
}

/** Dependencies for {@link initTestUpload}. */
export interface InitTestUploadDeps {
  db: Kysely<Database>;
  cacheStorage?: CacheStorage;
}

/**
 * Mint an upload record and return a presigned PUT URL + ephemeral X25519
 * public key. The encryption keypair is generated per upload; the private key
 * is stored orchestrator-side for post-PUT decryption. The `internal` flag
 * selects the host-facing vs the external/dev-reachable presign endpoint.
 */
export async function initTestUpload(
  deps: InitTestUploadDeps,
  params: InitTestUploadParams,
): Promise<InitTestUploadResult> {
  const { routingKey, sha, fileCount, compressedSize } = params;

  // Generate ephemeral X25519 keypair for upload encryption.
  const { publicKey, privateKey } = generateKeyPairSync('x25519');
  const publicKeyDer = publicKey.export({ type: 'spki', format: 'der' });
  const privateKeyDer = privateKey.export({ type: 'pkcs8', format: 'der' });

  const uploadId = randomUUID();
  const sanitizedKey = sanitizeRoutingKey(routingKey);
  const storageKey = `test-uploads/${sanitizedKey}/${sha ?? 'unknown'}/${uploadId}.tar.gz.enc`;

  let signedUrl = '';
  if (deps.cacheStorage) {
    signedUrl = params.internal
      ? await deps.cacheStorage.getInternalUploadUrl(storageKey)
      : await deps.cacheStorage.getUploadUrl(storageKey);
  }

  const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24h
  await deps.db
    .insertInto('test_uploads')
    .values({
      upload_id: uploadId,
      routing_key: routingKey,
      sha: sha ?? null,
      file_count: fileCount ?? null,
      compressed_size: compressedSize ?? null,
      storage_key: storageKey,
      encryption_private_key: (privateKeyDer as Buffer).toString('base64'),
      status: 'pending',
      expires_at: expiresAt,
      created_by: params.createdBy ?? null,
    })
    .execute();

  logger.info('Upload initialized', {
    uploadId,
    routingKey,
    sha: sha ?? 'unknown',
    storageKey,
    internal: !!params.internal,
  });

  return {
    uploadId,
    signedUrl,
    publicKey: (publicKeyDer as Buffer).toString('base64'),
    expiresIn: 3600,
  };
}

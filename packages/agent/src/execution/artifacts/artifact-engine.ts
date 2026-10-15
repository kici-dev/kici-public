/**
 * Sandbox-side user artifacts engine.
 *
 * `ctx.artifacts.upload(name, paths)` packs a gzip tarball and uploads it under
 * a run-scoped, named key; `download(name, destDir)` fetches to a temp file and
 * extracts only after its SHA-256 verifies. It reuses the cache engine's
 * pack/extract/anchor primitives (`packCachePaths`, `downloadAndExtractCache`);
 * only addressing (named, immutable per run) and transport differ.
 *
 * Talks to the orchestrator over an injected transport (IPC -> agent WS ->
 * orchestrator) and holds no bucket credentials, only presigned URLs. An
 * enforcement rejection (duplicate name, size cap, run cap, org quota) throws
 * the orchestrator's reason verbatim. A non-enforcement refusal (unconfigured,
 * unresolvable run, store error) surfaces as `artifact "<name>": <detail>` on
 * both paths, so it never reads as a quota rejection or a missing artifact.
 *
 * An invalid name is refused here, before the wire, in that same shape from the
 * shared engine builder, so the author reads one sentence whichever side caught it.
 */
import { createLogger } from '@kici-dev/shared';
import type { ArtifactsApi, ArtifactResult } from '@kici-dev/sdk';
import { artifactInvalidNameError, checkArtifactName } from '@kici-dev/engine';
import type {
  ArtifactRejectReason,
  ArtifactUploadOutcome,
  ArtifactDownloadOutcome,
} from '@kici-dev/engine';
import { packCachePaths, downloadAndExtractCache, type CacheRoots } from '../cache/cache-engine.js';

const logger = createLogger({ prefix: 'artifact-engine' });

export interface ArtifactBeginUploadResult {
  outcome: ArtifactUploadOutcome;
  /** Present only on `granted`. */
  uploadUrl?: string;
  /** Echoed back on complete; present only on `granted`. */
  storageKey?: string;
  /** Present only on an enforcement `rejected`. */
  reason?: ArtifactRejectReason;
  /**
   * Present only on `rejected` with no enforcement `reason` (invalid name,
   * orchestrator misconfiguration, internal error). A safe fixed string, never a raw exception.
   */
  error?: string;
}

export interface ArtifactDownloadLookup {
  outcome: ArtifactDownloadOutcome;
  /** Present only on `found`. */
  downloadUrl?: string;
  /** Bytes; present only on `found`. */
  sizeBytes?: number;
  /** Hex digest of the tarball bytes; present only on `found`. */
  sha256?: string;
  /**
   * Present only on a `not_found` caused by an orchestrator failure rather than
   * a missing artifact. A safe fixed string, never a raw exception.
   */
  error?: string;
}

/** IPC -> WS transport to the orchestrator (mirrors {@link CacheTransport}). */
export interface ArtifactTransport {
  /** Presigned PUT for `name`; limits are enforced before minting. */
  beginUpload(name: string, declaredSizeBytes: number): Promise<ArtifactBeginUploadResult>;
  /** Records the DB row. */
  completeUpload(name: string, sha256: string): Promise<void>;
  /** A named artifact of this run, as a presigned GET + size/sha256. */
  download(name: string): Promise<ArtifactDownloadLookup>;
}

function rejectionMessage(name: string, reason?: ArtifactRejectReason, error?: string): string {
  switch (reason) {
    case 'duplicate_name':
      return `artifact "${name}" already uploaded in this run (artifacts are immutable per run)`;
    case 'size_cap':
      return `artifact "${name}" exceeds the per-artifact size cap`;
    case 'run_cap':
      return `artifact "${name}" would exceed this run's artifact count cap`;
    case 'org_quota':
      return `artifact "${name}" would exceed the organization's artifact storage quota`;
    default:
      // Non-enforcement: the orchestrator's safe detail, else a generic fallback.
      return error ? `artifact "${name}": ${error}` : `artifact "${name}" upload was rejected`;
  }
}

/**
 * Reject an invalid name with the orchestrator's sentence. The sandbox bypasses
 * {@link rejectionMessage}'s default branch, so it adds the
 * `artifact "<name>": ` prefix itself to render one string on both paths.
 */
function assertArtifactName(name: string): void {
  const detail = checkArtifactName(name);
  if (detail) throw new Error(`artifact "${name}": ${artifactInvalidNameError(detail)}`);
}

export function createArtifactsApi(
  workDir: string,
  transport: ArtifactTransport,
  roots?: CacheRoots,
): ArtifactsApi {
  return {
    async upload(name: string, paths: string[]): Promise<ArtifactResult> {
      assertArtifactName(name);
      if (paths.length === 0)
        throw new Error(`artifact "${name}" upload requires at least one path`);
      // Pack first so the declared size is the exact tarball size the gates evaluate.
      const { tarball, hash } = await packCachePaths(workDir, paths, roots);
      const grant = await transport.beginUpload(name, tarball.length);
      if (grant.outcome === 'rejected' || !grant.uploadUrl) {
        throw new Error(rejectionMessage(name, grant.reason, grant.error));
      }
      const { uploadToPresignedUrl } = await import('../download.js');
      await uploadToPresignedUrl(grant.uploadUrl, tarball);
      await transport.completeUpload(name, hash);
      logger.info('artifact uploaded', {
        name,
        sizeBytes: tarball.length,
        sha256: hash.slice(0, 12),
      });
      return { size: tarball.length, sha256: hash };
    },
    async download(name: string, destDir?: string): Promise<ArtifactResult> {
      assertArtifactName(name);
      const lookup = await transport.download(name);
      if (lookup.outcome === 'not_found' || !lookup.downloadUrl || !lookup.sha256) {
        // A `not_found` with a detail is an orchestrator failure, not a missing artifact.
        throw new Error(
          lookup.error
            ? `artifact "${name}": ${lookup.error}`
            : `artifact "${name}" was not found in this run`,
        );
      }
      const dest = destDir ?? workDir;
      await downloadAndExtractCache(lookup.downloadUrl, dest, lookup.sha256, roots);
      logger.info('artifact downloaded', { name, destDir: dest, sizeBytes: lookup.sizeBytes });
      return { size: lookup.sizeBytes ?? 0, sha256: lookup.sha256 };
    },
  };
}

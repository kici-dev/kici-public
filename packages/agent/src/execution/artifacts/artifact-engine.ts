/**
 * User-facing artifacts engine (sandbox-side).
 *
 * Packs `ctx.artifacts.upload(name, paths)` into a gzip tarball and uploads it
 * under a run-scoped, named key; `ctx.artifacts.download(name, destDir)` streams
 * the tarball back with on-the-fly SHA-256 verification and extracts it. Reuses
 * the cache engine's pack/extract/anchor primitives (`packCachePaths`,
 * `downloadAndExtractCache`) — the tar layout, path-safety, and multi-root
 * anchoring are identical; only the addressing (named + immutable-per-run
 * instead of content-keyed) and the transport differ.
 *
 * Drives the orchestrator over an injected request-response transport
 * (IPC -> agent WS -> orchestrator); the agent never holds bucket credentials
 * (presigned URLs only). A rejected upload (duplicate name, size cap, run cap,
 * org quota) throws with the orchestrator's reason verbatim; a missing artifact
 * on download throws a clear not-found error. When the refusal is not an
 * enforcement gate — artifacts are unconfigured, the run is unresolvable, or the
 * store errored — the orchestrator sends a safe free-text detail that both paths
 * surface as `artifact "<name>": <detail>`, so a misconfiguration is never
 * mistaken for a quota rejection or a missing artifact.
 *
 * A name that violates the artifact-name contract is refused here, before the
 * wire, and rendered in that same `artifact "<name>": <detail>` shape from the
 * shared engine builder — so the author reads one sentence whether the sandbox
 * or the orchestrator caught it.
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

/** Outcome of a begin-upload grant request. */
export interface ArtifactBeginUploadResult {
  outcome: ArtifactUploadOutcome;
  /** Presigned PUT URL — present only on `granted`. */
  uploadUrl?: string;
  /** Storage key echoed back on complete — present only on `granted`. */
  storageKey?: string;
  /** Enforcement-gate rejection reason — present only on an enforcement `rejected`. */
  reason?: ArtifactRejectReason;
  /**
   * Non-enforcement refusal detail — present only on `rejected` when no
   * enforcement `reason` applies (a name that violates the artifact-name
   * contract, orchestrator misconfiguration, or an internal error). A safe,
   * fixed string from the orchestrator; never a raw exception.
   */
  error?: string;
}

/** Outcome of a download lookup. */
export interface ArtifactDownloadLookup {
  outcome: ArtifactDownloadOutcome;
  /** Presigned GET URL — present only on `found`. */
  downloadUrl?: string;
  /** Artifact size in bytes — present only on `found`. */
  sizeBytes?: number;
  /** SHA-256 (hex) of the tarball bytes — present only on `found`. */
  sha256?: string;
  /**
   * Internal-failure detail — present only on `not_found` when the outcome
   * reflects an orchestrator failure rather than a genuinely missing artifact. A
   * safe, fixed string from the orchestrator; never a raw exception.
   */
  error?: string;
}

/**
 * Transport the artifacts engine uses to reach the orchestrator over IPC -> WS.
 * Backed by the agent's request/response relay (mirrors {@link CacheTransport}).
 */
export interface ArtifactTransport {
  /** Request a presigned PUT for `name` at `declaredSizeBytes`; enforced before minting. */
  beginUpload(name: string, declaredSizeBytes: number): Promise<ArtifactBeginUploadResult>;
  /** Confirm the upload finished — records the DB row. */
  completeUpload(
    name: string,
    sizeBytes: number,
    sha256: string,
    storageKey: string,
  ): Promise<void>;
  /** Resolve a named artifact of this run to a presigned GET + its size/sha256. */
  download(name: string): Promise<ArtifactDownloadLookup>;
}

/** Human-readable message for an upload rejection reason or internal-failure detail. */
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
      // No enforcement reason: surface the orchestrator's safe non-enforcement
      // detail when it sent one, else the generic fallback (which is also what
      // an older orchestrator that sends neither produces).
      return error ? `artifact "${name}": ${error}` : `artifact "${name}" upload was rejected`;
  }
}

/**
 * Reject a name that violates the shared contract with the same sentence the
 * orchestrator would have produced.
 *
 * The `artifact "<name>": ` prefix is added here deliberately. On the
 * orchestrator path that prefix comes from {@link rejectionMessage}'s default
 * branch; the sandbox throws directly and bypasses it, so it has to supply the
 * prefix itself for the two paths to render one string.
 */
function assertArtifactName(name: string): void {
  const detail = checkArtifactName(name);
  if (detail) throw new Error(`artifact "${name}": ${artifactInvalidNameError(detail)}`);
}

/** Build the imperative `ctx.artifacts` API bound to a workDir + transport. */
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
      // Pack first so the declared size sent to the orchestrator is the exact
      // tarball size the enforcement gates evaluate.
      const { tarball, hash } = await packCachePaths(workDir, paths, roots);
      const grant = await transport.beginUpload(name, tarball.length);
      if (grant.outcome === 'rejected' || !grant.uploadUrl || !grant.storageKey) {
        throw new Error(rejectionMessage(name, grant.reason, grant.error));
      }
      const { uploadToPresignedUrl } = await import('../download.js');
      await uploadToPresignedUrl(grant.uploadUrl, tarball);
      await transport.completeUpload(name, tarball.length, hash, grant.storageKey);
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
        // A `not_found` carrying a detail is an orchestrator failure, not a
        // missing artifact — say so instead of sending the author looking for
        // an upload that was never the problem.
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

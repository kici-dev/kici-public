/**
 * Artifact name constraints: a filesystem/URL-safe token. The schema is hosted
 * in `@kici-dev/engine` because it is a trust-boundary contract the orchestrator
 * enforces on every inbound upload, not only an SDK-side call check. Re-exported
 * here unchanged, so the public SDK surface is stable and a name the SDK accepts
 * is exactly a name the orchestrator accepts.
 */
export { ArtifactNameSchema, ARTIFACT_NAME_MAX_LENGTH } from '@kici-dev/engine';

/** Result of an artifact upload or download: the packed size and content hash. */
export interface ArtifactResult {
  /** Size of the packed tarball in bytes. */
  size: number;
  /** SHA-256 (hex) of the packed tarball bytes. */
  sha256: string;
}

/**
 * Imperative artifacts API exposed on `StepContext` as `ctx.artifacts`.
 *
 * Artifacts are named, durable build deliverables shared between jobs of the
 * same run and surfaced in the dashboard run detail. Unlike the cache
 * (content-keyed, eviction-tolerant speedup) and job outputs (small JSON passed
 * via `needs`), an artifact is a first-class deliverable:
 *
 * - **Immutable per run:** the first upload of a name within a run wins; a
 *   duplicate name fails loudly (parallel writers become a deterministic error,
 *   never a silent clobber).
 * - **Downloadable by any later job** of the same run, and by a human from the
 *   run detail page.
 */
export interface ArtifactsApi {
  /**
   * Pack the given paths (repo-root-relative or `~`-prefixed) into a tarball
   * and upload it as a named artifact. The first upload of a name in a run
   * wins; a duplicate name, an over-cap size, or an exhausted quota throws with
   * the rejection reason. Returns the packed size + sha256.
   */
  upload(name: string, paths: string[]): Promise<ArtifactResult>;
  /**
   * Download a named artifact uploaded earlier in this run and extract it into
   * `destDir` (default: the step's working directory). Throws when the name was
   * never uploaded in this run. Returns the artifact's size + sha256.
   */
  download(name: string, destDir?: string): Promise<ArtifactResult>;
}

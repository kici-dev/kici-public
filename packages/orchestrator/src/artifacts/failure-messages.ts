/**
 * Safe, fixed messages the orchestrator sends to the agent (and through it to
 * the workflow author) when a user-artifact request is refused for something
 * other than an enforcement gate or a genuine lookup miss — an internal failure,
 * or a request that violates the artifact-name contract.
 *
 * These are presentation strings, not a wire vocabulary: the protocol carries
 * them in the free-text `error` field of `artifacts.upload.response` /
 * `artifacts.download.response` and in the free-text `reason` field of
 * `artifacts.upload.complete.ack`, so an orchestrator is free to reword them
 * without any agent-side change. They live here — rather than inline at each
 * send site — so the handler and its tests share one definition.
 *
 * Raw exception text is never one of these. Exceptions stay in the
 * orchestrator's own logs; the author sees only "this is an orchestrator or
 * configuration problem", never a database endpoint or a stack frame.
 */
export const ArtifactInternalFailure = Object.freeze({
  /** Upload requested but the orchestrator has no artifact store configured. */
  uploadNotConfigured: 'artifact uploads are not configured on this orchestrator',
  /** Download requested but the orchestrator has no artifact store configured. */
  downloadNotConfigured: 'artifact downloads are not configured on this orchestrator',
  /** The job's run could not be resolved server-side (upload and download). */
  unresolvableRun: 'the run for this job could not be resolved on the orchestrator',
  /** `beginUpload` threw. */
  uploadFailed: 'the orchestrator hit an internal error while starting the upload',
  /** `download` threw. */
  downloadFailed: 'the orchestrator hit an internal error while resolving the download',
  /** `completeUpload` threw with no more specific classification. */
  commitFailed: 'the orchestrator hit an internal error while committing the upload',
  /** The uploaded object was absent from storage at commit time. */
  commitObjectMissing:
    'the uploaded artifact object was not found in storage — the upload may not have completed',
} as const);

/**
 * The artifact-name rejection prefix and message builder are defined in
 * `@kici-dev/engine`, beside `ArtifactNameSchema` itself, so the orchestrator and
 * the agent sandbox render one wording. Such a rejection is neither an
 * enforcement gate (nothing about the org's usage refuses it) nor an internal
 * failure — the sandbox validates the same contract at the call site, so a name
 * only reaches this path from an agent that bypassed or predates that check.
 *
 * Re-exported here because this module is where the orchestrator's artifact
 * failure messages live — callers keep their existing import path.
 */
export { ARTIFACT_INVALID_NAME_PREFIX, artifactInvalidNameError } from '@kici-dev/engine';

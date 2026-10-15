/**
 * Safe, fixed messages the orchestrator sends to the agent (and through it to
 * the workflow author) when a user-artifact request is refused for an internal
 * failure or an artifact-name contract violation, rather than an enforcement
 * gate or a genuine lookup miss.
 *
 * Presentation strings, not a wire vocabulary: they ride the free-text `error`
 * of `artifacts.upload.response` / `artifacts.download.response` and `reason`
 * of `artifacts.upload.complete.ack`, so they can be reworded with no agent
 * change. Defined once so the handler and its tests share them.
 *
 * Raw exception text is never sent: it stays in the orchestrator's logs, and
 * the author never sees a database endpoint or a stack frame.
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
 * Defined in `@kici-dev/engine` beside `ArtifactNameSchema`, so the orchestrator
 * and the agent sandbox render one wording. A name rejection is neither an
 * enforcement gate (nothing about the org's usage refuses it) nor an internal
 * failure. The sandbox validates the same contract at the call site, so an
 * invalid name only reaches the orchestrator from an agent that bypassed or
 * predates that check. Re-exported so callers import every artifact failure
 * message from here.
 */
export { ARTIFACT_INVALID_NAME_PREFIX, artifactInvalidNameError } from '@kici-dev/engine';

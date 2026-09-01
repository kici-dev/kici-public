/**
 * The one rendering of a run's reduced-privilege posture, for the provider
 * checks a contributor reads on a pull request.
 *
 * It lives beside `trust-resolver.ts` and `lock-source.ts` — the two modules
 * that decide the values it reads — rather than in the pipeline, because both
 * the dispatch pipeline and the check-run reporter render it and
 * `pipeline/processor.ts` already imports from `reporting/`.
 */

/**
 * Lead-in of the reduced-privilege note. Exported so every surface that renders
 * it, and their tests, name one string rather than a copy each.
 */
export const REDUCED_PRIVILEGE_MARKER = '**Reduced privileges (untrusted ref).**';

/**
 * The reduced-privilege posture of a run whose ref resolved to a tier other
 * than `trusted`.
 *
 * Attach it only where the run the check describes actually executes. It is NOT
 * attached to the trust-policy REJECTION: that run is never dispatched, so on
 * that check the clauses below are vacuously true and read as a promise about a
 * run that will not happen. The trust-policy HOLD does carry it — approving one
 * replays the dispatch under the same trust resolution, so the reductions the
 * clauses name are the ones the resumed run really runs under. Storing a resume
 * context is not by itself the trigger: `holdWorkflowForInstallGate` stores one
 * and posts no check at all, so it has nothing to attach the note to. See the
 * call sites in `dispatch-matched-workflow.ts` for which checks a resuming hold
 * actually posts.
 *
 * Returns null for a trusted ref and for a run whose trust never resolved. An
 * absent tier is deliberately NOT treated as untrusted: `isUntrustedTier` in
 * `install-secrets-resolver.ts` reads it leniently and leaves the install
 * secrets in place, so a run with no tier has no withholding to report. The
 * predicate for a resolved tier is "other than `trusted`", matching
 * `isUntrustedTier` and `selectLockFileSource`. `deriveCacheRefScope` is
 * stricter — it isolates an absent tier too — so an unresolved run's cache
 * really is isolated while this note stays silent about it. Under-reporting is
 * the safe direction: the note never claims a reduction that did not happen.
 *
 * Each clause names something already decided for THIS run rather than a
 * mechanism:
 *
 * - `resolveInstallSecrets` returns `npmRegistries: undefined` and
 *   `installEnvSecrets: undefined` for a resolved non-trusted tier, so the run
 *   carries neither.
 * - `deriveCacheRefScope` returns the isolated scope for the same tiers, and
 *   `UserCache` confines WRITES to it; a restore still falls back to the shared
 *   scope, so the clause is about what the run saves, not what it can read.
 * - the base-branch clause is keyed on the run's recorded `lockFileSource`, not
 *   on the tier: `selectLockFileSource` returns `base` only for a pull-request
 *   event, and an untrusted tier also reaches an internal-event child run that
 *   inherited it.
 *
 * Kept in step with the dashboard's reduced-privilege banner
 * (`packages/dashboard/src/components/run-detail/degraded-run-banner.tsx`),
 * which describes the same run and may be read beside these checks.
 */
export function buildReducedPrivilegeNote(
  tier: string | null | undefined,
  lockFileSource?: string | null,
): string | null {
  if (!tier || tier === 'trusted') return null;
  const parts = [
    `${REDUCED_PRIVILEGE_MARKER} This run does not carry the workflow's registry or ` +
      'install secrets, and its build-cache writes are confined to this run.',
  ];
  if (lockFileSource === 'base') {
    parts.push(
      'Workflow definitions were read from the base branch, so workflow changes on this ref did not take effect.',
    );
  }
  return parts.join(' ');
}

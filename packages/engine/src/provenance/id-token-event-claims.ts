/**
 * The event-context half of an OIDC ID token's claims, shared by every minter.
 *
 * A cloud trust policy pins `sub` and, ideally, the claims below. Those values
 * are what tells a fork pull request from a trusted push, so the two minters —
 * the customer's orchestrator and the hosted Platform — must derive them
 * identically. Any drift between them is a hole: a bundle minted by one would
 * satisfy a policy written against the other. So the derivation lives here,
 * once, and each minter spreads the result into its own claim object.
 */
import { z } from 'zod';
import { isPullRequestFamilyTriggerEvent } from '../trigger/trigger-event-type.js';

/** The run columns the event claims read. Every one may be absent. */
export interface EventClaimSource {
  repo_identifier: string | null;
  ref: string | null;
  workflow_name: string | null;
  /** Normalized event that started the run (`push`, `pull_request:opened`, …). */
  trigger_event?: string | null;
  /**
   * The event the SUBJECT is derived from, when that is not `trigger_event`.
   *
   * A re-run records `trigger_event: 'rerun'`, which carries no pull-request
   * dimension, so a re-run of a pull request would present the branch-shaped
   * subject a push to the same base branch presents. This column carries the
   * original run's event forward for that one purpose. NULL means "use
   * `trigger_event`", which is what every row written before the column
   * existed says — so a legacy row keeps the subject it already mints.
   *
   * Read ONLY by `buildIdTokenSubject`. It is deliberately absent from
   * `buildEventClaims`: `event_name` reports what actually started THIS run,
   * and a re-run is a re-run.
   */
  subject_trigger_event?: string | null;
  /** Pull-request HEAD branch. */
  head_ref?: string | null;
  /** `owner/repo` of the pull-request HEAD. */
  head_repository?: string | null;
  /** True for a fork pull request. NULL means the run did not resolve one. */
  is_fork?: boolean | null;
  /** Resolved trust tier for the triggering actor. */
  trust_tier?: string | null;
  /** Provider login of the triggering actor. */
  trigger_actor_username?: string | null;
}

/**
 * The event-context claims. Every value is a STRING and every one is ALWAYS
 * PRESENT.
 *
 * Strings because an AWS IAM `StringEquals` condition on an OIDC claim is
 * string-typed and a three-valued `is_fork` has to be expressible. Always
 * present because an ABSENT claim makes a `StringEquals` condition fail — which
 * silently removes the constraint for a policy author who wrote it expecting
 * enforcement. An explicit `''` / `'unresolved'` makes that policy fail closed
 * instead, and makes the unknown state visible in a decoded token.
 */
export interface EventClaims {
  /** Normalized event type, or `'unknown'`. */
  event_name: string;
  /** The BASE branch — the same value as `ref`, named the way GitHub names it. */
  base_ref: string;
  /** The pull-request HEAD branch, or `''`. */
  head_ref: string;
  /** `owner/repo` of the pull-request HEAD, or `''`. */
  head_repository: string;
  /** `'true'` / `'false'`, or `'unresolved'` when the run resolved no answer. */
  is_fork: string;
  /** The run's trust tier, or `'unresolved'`. */
  trust_tier: string;
  /** Provider login of the triggering actor, or `''`. */
  actor: string;
}

/** The sentinel for a value the run did not resolve. Never a plausible default. */
export const UNRESOLVED_CLAIM = 'unresolved';

/**
 * Build the event-context claims from a run row.
 *
 * A NULL never becomes a plausible default. `head_repository` does not fall
 * back to `repository`, and `is_fork` does not fall back to `'false'`: both
 * would fail OPEN on a lost write, which is the failure these claims exist to
 * remove.
 */
export function buildEventClaims(run: EventClaimSource): EventClaims {
  return {
    event_name: run.trigger_event ?? 'unknown',
    base_ref: run.ref ?? '',
    head_ref: run.head_ref ?? '',
    head_repository: run.head_repository ?? '',
    is_fork: run.is_fork == null ? UNRESOLVED_CLAIM : String(run.is_fork),
    trust_tier: run.trust_tier ?? UNRESOLVED_CLAIM,
    actor: run.trigger_actor_username ?? '',
  };
}

/**
 * Build the token subject.
 *
 * Two shapes, mirroring GitHub Actions' own claim vocabulary — which is what
 * every customer's existing trust policy is written against:
 *
 *   - pull-request family: `repo:<owner/repo>:pull_request`, with NO ref
 *     segment. GitHub omits the ref there for exactly this reason.
 *   - everything else: `repo:<owner/repo>:ref:<ref>:workflow:<name>`, unchanged.
 *
 * A pull request's `ref` is its BASE branch, so the branch-shaped subject made
 * a fork PR against `main` byte-identical to a trusted push to `main`. An
 * external contributor whose PR ran the same workflow minted the exact string a
 * policy pinned, and assumed the customer's cloud role. The two shapes cannot
 * collide: no branch name produces the literal segment `pull_request` in the
 * position a branch subject puts `ref`.
 *
 * The event tested is `subject_trigger_event ?? trigger_event`. A re-run writes
 * `trigger_event: 'rerun'` and carries the original run's event in
 * `subject_trigger_event`, so re-running a pull request keeps the
 * pull-request subject instead of decaying to the colliding branch shape.
 * `trigger_event` itself is left alone because two other readers depend on it:
 * the dashboard's trigger-type filter and the git credential relay's
 * `triggerTypeFilters`, both of which must keep seeing `'rerun'`.
 *
 * `legacyPullRequestSubject` restores the old, colliding form for one release —
 * see `KICI_OIDC_LEGACY_PR_SUB`. It is deprecated on arrival.
 *
 * @deprecated `legacyPullRequestSubject` is removed at v1.0.0.
 */
export function buildIdTokenSubject(
  run: Pick<
    EventClaimSource,
    'repo_identifier' | 'ref' | 'workflow_name' | 'trigger_event' | 'subject_trigger_event'
  >,
  opts?: { legacyPullRequestSubject?: boolean },
): string {
  const repository = run.repo_identifier ?? 'unknown';
  const subjectEvent = run.subject_trigger_event ?? run.trigger_event;
  if (!opts?.legacyPullRequestSubject && isPullRequestFamilyTriggerEvent(subjectEvent)) {
    return `repo:${repository}:pull_request`;
  }
  return `repo:${repository}:ref:${run.ref ?? 'unknown'}:workflow:${run.workflow_name ?? 'unknown'}`;
}

/**
 * The orchestrator's own view of a build, sent with the job so the agent can
 * freeze a provenance statement that matches what a live mint would say.
 *
 * Every field mirrors a claim `buildIdTokenClaims` derives, so a statement
 * built from this passes `crossCheckBuildContext` against the token that is
 * later minted for the same (run, job) — which is what lets the orchestrator
 * refuse a deferred statement it has not checked against its own run row.
 *
 * `.passthrough()` so an older agent tolerates a field a newer orchestrator
 * adds.
 */
export const provenanceContextSchema = z
  .object({
    /** `owner/repo`, the token's `repository` claim. */
    repository: z.string().nullable(),
    /** The branch the run PRESENTS — a pull request's BASE branch. */
    ref: z.string().nullable(),
    /** The run's commit SHA, the token's `sha` claim. */
    sha: z.string().nullable(),
    /**
     * The token's `workflow_ref` claim (`<workflow_name>@<sha>`) — NOT the git
     * ref used to clone a global workflow's repository. The statement's
     * `workflow.path` is compared against this.
     */
    workflowRef: z.string().nullable(),
    runId: z.string(),
    jobId: z.string(),
    /** The customer's public org id, resolved server-side from the routing key. */
    orgId: z.string(),
    /** `triggered` or `run-remote`, derived from the run's local-working-tree flag. */
    sourceOrigin: z.string(),
    /** Informational source provider (github / gitlab / …). */
    provider: z.string().nullable(),
    /** The orchestrator's provenance issuer, for the statement's `builder.id`. */
    issuer: z.string(),
    /** This orchestrator's instance id, also for `builder.id`. */
    orchestratorId: z.string(),
  })
  .passthrough();

export type ProvenanceContext = z.infer<typeof provenanceContextSchema>;

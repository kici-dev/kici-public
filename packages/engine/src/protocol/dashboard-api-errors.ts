import { z } from 'zod';

/**
 * Structured `error` codes in Platform dashboard API JSON bodies that the
 * dashboard special-cases; shared so the Platform emit sites and the dashboard
 * match site never drift. A route whose `error` already holds a message for
 * older clients sends the code in a separate `code` field instead.
 */
export const DashboardApiErrorCode = z.enum([
  /**
   * The named orchestrator cluster has no connected orchestrator. Returned with
   * 404. The cluster may be reconnecting, so a client polling a run it already
   * started retries it.
   */
  'orchestrator_not_found',
  'session_max_age_exceeded',
  /**
   * The run exists but is outside the org's plan retention window (soft-deleted,
   * or created before the cutoff). Returned with 404, not 403 or 410, so the
   * status alone reveals nothing. The Platform resolves runs through the
   * org-scoped handle, so only the owning org ever sees this code; a caller
   * probing another org's ids gets the ordinary not-found. The code lets the
   * dashboard explain the retention window.
   */
  'run_outside_retention',
  /**
   * A run-minting route (a re-run, a schedule fired by hand) relayed the
   * request and the orchestrator did not answer in time. Returned with 504.
   * The orchestrator may still have accepted the request, so the run may still
   * start: a client says so and points at the run list, never "retry".
   */
  'run_start_unconfirmed',
  /**
   * The Platform has no organization for a first sign-in to join yet. Returned
   * with 403.
   */
  'install_not_initialized',
  /** This Platform does not allow creating organizations. Returned with 403. */
  'org_creation_disabled',
  /** The installation is at its organization limit. Returned with 403. */
  'org_limit_reached',
  /** Only administrators of this installation can create organizations. Returned with 403. */
  'org_creation_owner_only',
  /** The invite is for another email address than the signed-in account's. 403. */
  'invite_email_mismatch',
  /** Members plus pending invites fill the plan (403, with `upgradeUrl`; legacy spelling). */
  'PLAN_LIMIT_MEMBER',
  /** The organization reached its invite emails for the last 24 hours. 429. */
  'invite_budget_spent',
  /** The CLI is a later release than the Platform. 409, with a `message` the CLI prints. */
  'client_newer_than_platform',
]);
export type DashboardApiErrorCode = z.infer<typeof DashboardApiErrorCode>;

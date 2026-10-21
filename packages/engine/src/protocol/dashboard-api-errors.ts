import { z } from 'zod';

/**
 * Structured `error` codes in Platform dashboard API JSON bodies that the
 * dashboard special-cases; shared so the Platform emit sites and the dashboard
 * match site never drift.
 */
export const DashboardApiErrorCode = z.enum([
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
]);
export type DashboardApiErrorCode = z.infer<typeof DashboardApiErrorCode>;

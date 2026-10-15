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
]);
export type DashboardApiErrorCode = z.infer<typeof DashboardApiErrorCode>;

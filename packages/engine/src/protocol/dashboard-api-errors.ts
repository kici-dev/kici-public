import { z } from 'zod';

/**
 * Structured `error` codes the Platform dashboard API returns in a JSON body,
 * which the dashboard SPA special-cases when rendering. Shared so the emit
 * sites (Platform) and the match site (dashboard) never drift on the literal.
 */
export const DashboardApiErrorCode = z.enum([
  'orchestrator_not_found',
  'session_max_age_exceeded',
  /**
   * The addressed run exists but falls outside the org's plan retention window
   * (soft-deleted, or created before the retention cutoff). Returned with 404
   * rather than 403 or 410 so the status alone reveals nothing. The Platform
   * resolves the run through its org-scoped handle, so this code is only ever
   * emitted for a run the caller's own org owns — a caller probing another
   * org's ids gets the route's ordinary not-found. The distinct code is what
   * lets the dashboard explain the retention window to the owning org.
   */
  'run_outside_retention',
]);
export type DashboardApiErrorCode = z.infer<typeof DashboardApiErrorCode>;

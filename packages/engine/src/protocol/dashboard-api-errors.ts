import { z } from 'zod';

/**
 * Structured `error` codes the Platform dashboard API returns in a JSON body,
 * which the dashboard SPA special-cases when rendering. Shared so the emit
 * sites (Platform) and the match site (dashboard) never drift on the literal.
 */
export const DashboardApiErrorCode = z.enum(['orchestrator_not_found', 'session_max_age_exceeded']);
export type DashboardApiErrorCode = z.infer<typeof DashboardApiErrorCode>;

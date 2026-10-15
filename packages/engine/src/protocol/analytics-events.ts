//
// Canonical names for the custom analytics events the frontends (dashboard
// handlers, docs click listener) fire into Umami. Browser-safe; the dashboard
// imports it via `@kici-dev/engine/protocol/analytics-events`. Pageviews are
// automatic, not events; Splash is pageview-only (no CTA markup).
// `signup_completed` / `source_connected` are intentionally absent: no honest
// dashboard-side signal exists (registration is Keycloak-side; sources are
// registered orchestrator-side and the dashboard only lists them).
import { z } from 'zod';

export const AnalyticsEvent = z.enum([
  // Dashboard activation funnel.
  'login',
  'org_created',
  'secret_created',
  'workflow_run_triggered',
  'run_viewed',
  'billing_plan_selected',
  // Docs engagement.
  'code_copy',
  'docs_search',
  'cta_dashboard',
]);

export type AnalyticsEvent = z.infer<typeof AnalyticsEvent>;

/** The catalogue as a plain array (for build-time mirroring + tests). */
export const ANALYTICS_EVENTS = AnalyticsEvent.options;

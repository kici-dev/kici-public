//
// Canonical names for the custom analytics events fired into Umami from the
// frontends (dashboard React handlers, docs delegated click listener). Pure
// Zod + plain TypeScript with no node built-ins, so it stays browser-safe and
// is imported directly by the dashboard SPA via the subpath
// `@kici-dev/engine/protocol/analytics-events`. Pageviews are automatic and
// are NOT events. Splash is pageview-only (it has no CTA markup), and
// `signup_completed` / `source_connected` are intentionally absent — there is
// no honest dashboard-side signal for them (registration is Keycloak-side;
// sources are registered orchestrator-side and the dashboard only lists them).
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

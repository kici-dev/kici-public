/**
 * Route shape for a GitHub App webhook. Org-scoped, NOT app-scoped — the app
 * id does not appear, so the URL is resolvable before the App exists (the
 * manifest setup flow needs it up front to bake into the App manifest). Shared
 * by the Platform's webhook-URL builder and the orchestrator's manifest
 * pre-flight so the two never drift.
 */
export function githubWebhookPath(orgId: string): string {
  return `/webhook/${orgId}/github`;
}

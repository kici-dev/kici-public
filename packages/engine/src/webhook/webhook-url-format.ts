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

/**
 * Route shape for a direct GitHub-App webhook delivered straight to the
 * orchestrator (bypassing the Platform relay). Per-source: the `:sourceId`
 * segment identifies the local GitHub source. Shared by the orchestrator's
 * ingress route handler and its local URL resolver so the two never drift.
 */
export function githubIngressPath(orgId: string, sourceId: string): string {
  return `/webhook/${orgId}/github/${sourceId}`;
}

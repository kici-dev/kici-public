/**
 * Route shape for a GitHub App webhook. Org-scoped, NOT app-scoped: without the
 * app id the URL resolves before the App exists, as the manifest setup flow
 * bakes it into the App manifest. Shared by the Platform's relay route, the
 * orchestrator's org-scoped direct route, and both sides' URL builders.
 */
export function githubWebhookPath(orgId: string): string {
  return `/webhook/${orgId}/github`;
}

/**
 * Route shape for a GitHub-App webhook delivered straight to the orchestrator,
 * bypassing the Platform relay. The `:sourceId` segment identifies the local
 * GitHub source. Shared by the orchestrator's ingress route and its local URL
 * resolver.
 */
export function githubIngressPath(orgId: string, sourceId: string): string {
  return `/webhook/${orgId}/github/${sourceId}`;
}

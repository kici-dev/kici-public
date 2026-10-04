import { githubIngressPath, githubWebhookPath } from '@kici-dev/engine';

/**
 * Build the orchestrator's OWN direct GitHub ingress URL for a source, from
 * the configured public base (`KICI_WEBHOOK_PUBLIC_URL`). Returns null when no
 * public base is configured (the CLI then prints an honest "set
 * KICI_WEBHOOK_PUBLIC_URL" note instead of a fabricated URL).
 */
export function buildLocalGithubIngressUrl(
  webhookPublicUrl: string | undefined,
  orgId: string,
  sourceId: string,
): string | null {
  if (!webhookPublicUrl) return null;
  const base = webhookPublicUrl.replace(/\/$/, '');
  return `${base}${githubIngressPath(orgId, sourceId)}`;
}

/**
 * Build the orchestrator's OWN org-scoped GitHub App ingress URL
 * (`<base>/webhook/<orgId>/github`), served by the org-scoped direct route.
 * Null when no public base is configured.
 */
export function buildLocalGithubAppIngressUrl(
  webhookPublicUrl: string | undefined,
  orgId: string,
): string | null {
  if (!webhookPublicUrl) return null;
  return `${webhookPublicUrl.replace(/\/$/, '')}${githubWebhookPath(orgId)}`;
}

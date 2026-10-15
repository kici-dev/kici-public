import { githubIngressPath, githubWebhookPath } from '@kici-dev/engine';

/**
 * The orchestrator's OWN per-source GitHub ingress URL under
 * `KICI_WEBHOOK_PUBLIC_URL`. Null without it, so the CLI prints a "set
 * KICI_WEBHOOK_PUBLIC_URL" note instead of a fabricated URL.
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
 * The orchestrator's OWN org-scoped GitHub App ingress URL
 * (`<base>/webhook/<orgId>/github`). Null without a public base.
 */
export function buildLocalGithubAppIngressUrl(
  webhookPublicUrl: string | undefined,
  orgId: string,
): string | null {
  if (!webhookPublicUrl) return null;
  return `${webhookPublicUrl.replace(/\/$/, '')}${githubWebhookPath(orgId)}`;
}

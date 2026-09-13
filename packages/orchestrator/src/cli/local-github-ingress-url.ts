import { githubIngressPath } from '@kici-dev/engine';

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

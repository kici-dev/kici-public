/**
 * Every webhook-URL decision the orchestrator makes for a GitHub-App source,
 * by operating mode. Pure functions: the entry points (`server.ts`,
 * `standalone.ts`) pass in the mode, the public base, the org and the Platform
 * values, so each rule is unit-tested here once.
 */
import { z } from 'zod';
import { OrchestratorMode, OWN_INGRESS_MODES } from '@kici-dev/engine';
import {
  buildLocalGithubAppIngressUrl,
  buildLocalGithubIngressUrl,
} from '../cli/local-github-ingress-url.js';

/** Why a webhook URL could not be resolved. The CLI maps each to a reason and a hint. */
export const WebhookUrlNote = z.enum([
  'unsupported-provider',
  'no-public-url',
  'platform-no-public-url',
  'platform-unavailable',
  'platform-url-unknown',
  'org-not-identified',
  'resolver-unavailable',
  'resolve-failed',
]);
export type WebhookUrlNote = z.infer<typeof WebhookUrlNote>;

export interface WebhookUrlResolution {
  webhookUrl: string | null;
  webhookNote?: WebhookUrlNote;
}

/** Org segment an orchestrator with no Platform org puts in its URLs. Neither route checks it. */
export const DEFAULT_ORG_SEGMENT = '__default__';

export interface AddedSourceUrlInput {
  mode: OrchestratorMode;
  webhookPublicUrl: string | undefined;
  /** The Platform org this orchestrator authenticated as, when known. */
  orgId: string | undefined;
  sourceId: string;
  /** Push the full source list to the Platform; resolves the ack's URL for this source. */
  registerAndAwait: () => Promise<string | null>;
  onRegisterError: (err: unknown) => void;
}

/** The URL `kici-admin source add github` prints for a freshly added source. */
export async function resolveAddedGithubSourceUrl(
  input: AddedSourceUrlInput,
): Promise<WebhookUrlResolution> {
  const local = buildLocalGithubIngressUrl(
    input.webhookPublicUrl,
    input.orgId ?? DEFAULT_ORG_SEGMENT,
    input.sourceId,
  );
  if (input.mode === OrchestratorMode.enum.observed) {
    // The push is the live propagation of this add. The ack's URL is the
    // Platform's, which never delivers to an observed orchestrator.
    try {
      await input.registerAndAwait();
    } catch (err) {
      input.onRegisterError(err);
    }
    return local
      ? { webhookUrl: local }
      : { webhookUrl: null, webhookNote: WebhookUrlNote.enum['no-public-url'] };
  }
  let ackUrl: string | null;
  try {
    ackUrl = await input.registerAndAwait();
  } catch (err) {
    input.onRegisterError(err);
    return { webhookUrl: null, webhookNote: WebhookUrlNote.enum['platform-unavailable'] };
  }
  if (ackUrl) return { webhookUrl: ackUrl };
  // Platform mode serves no direct ingress, so its own URL would never deliver.
  return local && OWN_INGRESS_MODES.includes(input.mode)
    ? { webhookUrl: local }
    : { webhookUrl: null, webhookNote: WebhookUrlNote.enum['platform-no-public-url'] };
}

export interface ManifestUrlInput {
  mode: OrchestratorMode;
  webhookPublicUrl: string | undefined;
  orgId: string | undefined;
  /** `auth.success.githubWebhookUrl`; undefined when the Platform did not send it. */
  platformGithubWebhookUrl: string | null | undefined;
}

/**
 * The org-scoped URL the manifest flow bakes into a new App, before the App
 * (and so the source id) exists. Platform and hybrid point the App at the
 * hosted Platform; observed and independent at this orchestrator's
 * org-scoped direct route.
 */
export function resolveManifestGithubWebhookUrl(input: ManifestUrlInput): WebhookUrlResolution {
  const unknown = { webhookUrl: null, webhookNote: WebhookUrlNote.enum['platform-url-unknown'] };
  switch (input.mode) {
    case OrchestratorMode.enum.platform:
      return input.platformGithubWebhookUrl
        ? { webhookUrl: input.platformGithubWebhookUrl }
        : unknown;
    case OrchestratorMode.enum.hybrid: {
      if (input.platformGithubWebhookUrl) return { webhookUrl: input.platformGithubWebhookUrl };
      const local = input.orgId
        ? buildLocalGithubAppIngressUrl(input.webhookPublicUrl, input.orgId)
        : null;
      return local ? { webhookUrl: local } : unknown;
    }
    case OrchestratorMode.enum.observed: {
      if (!input.orgId) {
        return { webhookUrl: null, webhookNote: WebhookUrlNote.enum['org-not-identified'] };
      }
      const local = buildLocalGithubAppIngressUrl(input.webhookPublicUrl, input.orgId);
      return local
        ? { webhookUrl: local }
        : { webhookUrl: null, webhookNote: WebhookUrlNote.enum['no-public-url'] };
    }
    case OrchestratorMode.enum.independent: {
      const local = buildLocalGithubAppIngressUrl(input.webhookPublicUrl, DEFAULT_ORG_SEGMENT);
      return local
        ? { webhookUrl: local }
        : { webhookUrl: null, webhookNote: WebhookUrlNote.enum['no-public-url'] };
    }
  }
}

/** The direct-ingress URL `kici-admin source list` prints for a GitHub source, or null. */
export function resolveListedGithubIngressUrl(input: {
  mode: OrchestratorMode;
  webhookPublicUrl: string | undefined;
  orgId: string | undefined;
  sourceId: string;
}): string | null {
  if (!OWN_INGRESS_MODES.includes(input.mode) || !input.orgId) return null;
  return buildLocalGithubIngressUrl(input.webhookPublicUrl, input.orgId, input.sourceId);
}

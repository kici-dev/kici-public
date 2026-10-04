/**
 * The text the CLI prints when the orchestrator returns no webhook URL. Shared
 * by `kici-admin source add` and the manifest setup flow, so each
 * `WebhookUrlNote` reads the same in both.
 */
import { WebhookUrlNote } from '../sources/webhook-url-resolvers.js';

const DASHBOARD_HINT = 'Find the webhook URL in the dashboard under Sources.';

/**
 * Short reason shown in `(unavailable — <reason>)` when no webhook URL could be
 * resolved. Takes a plain string too, because an orchestrator of another
 * version can send a note this CLI does not know.
 */
export function webhookNoteReason(note: WebhookUrlNote | string | undefined): string {
  switch (note) {
    case WebhookUrlNote.enum['no-public-url']:
      return 'KICI_WEBHOOK_PUBLIC_URL is not set on the orchestrator';
    case WebhookUrlNote.enum['platform-no-public-url']:
      return 'the Platform has no public webhook URL configured';
    case WebhookUrlNote.enum['platform-unavailable']:
      return 'could not reach the Platform';
    case WebhookUrlNote.enum['platform-url-unknown']:
      return 'the Platform did not send its GitHub webhook URL';
    case WebhookUrlNote.enum['org-not-identified']:
      return 'the orchestrator does not know its Platform org yet';
    case WebhookUrlNote.enum['unsupported-provider']:
      return 'this provider has no webhook URL to print';
    case WebhookUrlNote.enum['resolver-unavailable']:
      return 'this orchestrator cannot resolve webhook URLs';
    case WebhookUrlNote.enum['resolve-failed']:
      return 'resolving the webhook URL failed';
    default:
      return 'webhook URL could not be determined';
  }
}

/** Actionable next-step hint paired with {@link webhookNoteReason}. */
export function webhookNoteHint(note: WebhookUrlNote | string | undefined): string {
  switch (note) {
    case WebhookUrlNote.enum['no-public-url']:
      return "Set KICI_WEBHOOK_PUBLIC_URL to the orchestrator's public base, then re-run; paste the printed URL into your GitHub App or repo webhook.";
    case WebhookUrlNote.enum['platform-unavailable']:
      return 'Retry once the orchestrator reconnects, or find the URL in the dashboard under Sources.';
    case WebhookUrlNote.enum['platform-url-unknown']:
      return 'Retry when the orchestrator is connected to the Platform, or pass --webhook-url with the URL the App must deliver to.';
    case WebhookUrlNote.enum['org-not-identified']:
      return 'Retry when the orchestrator is connected to the Platform, or pass --webhook-url.';
    case WebhookUrlNote.enum['unsupported-provider']:
      return "Configure the webhook from the provider's own settings.";
    case WebhookUrlNote.enum['resolve-failed']:
      return 'Retry; if it fails again, find the webhook URL in the dashboard under Sources.';
    case WebhookUrlNote.enum['platform-no-public-url']:
    case WebhookUrlNote.enum['resolver-unavailable']:
    default:
      return DASHBOARD_HINT;
  }
}

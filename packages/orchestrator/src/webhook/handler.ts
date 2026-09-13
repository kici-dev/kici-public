/**
 * Provider-agnostic webhook info.
 *
 * All provider-specific details are abstracted away. The routingKey
 * and provider fields enable provider lookup, while the rest of the
 * fields are universal across all webhook providers.
 */

import type { ProviderType } from '@kici-dev/engine';

export interface WebhookInfo {
  /** Routing key (e.g., "github:12345") */
  routingKey: string;
  /** Unique delivery ID */
  deliveryId: string;
  /** Provider event type (e.g., "push", "pull_request") */
  event: string;
  /** Action field from payload (e.g., "opened"), null if not present */
  action: string | null;
  /** Provider type (e.g., "github") */
  provider: ProviderType;
  /** Raw webhook payload */
  payload: Record<string, unknown>;
}

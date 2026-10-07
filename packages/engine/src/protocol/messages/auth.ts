import { z } from 'zod';
import { orchCapabilitiesSchema } from './capabilities.js';

// --- Auth protocol messages ---
// Used during WebSocket connection establishment between orchestrator and Platform.

/** Auth request sent by orchestrator to Platform when connecting via WebSocket. */
export const authRequestSchema = z.object({
  type: z.literal('auth.request'),
  token: z.string().min(1),
  protocolVersion: z.number().int().positive(),
  /** Orchestrator capabilities. */
  capabilities: orchCapabilitiesSchema,
});

/** Auth success response sent by Platform to orchestrator after successful authentication. */
export const authSuccessSchema = z.object({
  type: z.literal('auth.success'),
  connectionId: z.string(),
  /**
   * Public alias of the authenticated orchestrator's owning org
   * (`oal_<12-char>`). Used by the orchestrator's check-run emitter to
   * build a `details_url` that points at the dashboard's resolver
   * route, so the canonical `org_<12-char>` id never appears in URLs
   * that reach public surfaces.
   */
  orgPublicAlias: z.string(),
  /**
   * Canonical org id (`org_<…>`) of the authenticated orchestrator's owning
   * org. The orchestrator auto-provisions a `remote_sources` anchor
   * (`remote:<orgId>`) from this so `kici run remote` relayed through the
   * Platform resolves the real tenant.
   */
  orgId: z.string(),
  /**
   * The Platform's org-scoped GitHub App webhook URL
   * (`<WEBHOOK_PUBLIC_URL>/webhook/<orgId>/github`). It is known before any
   * App exists, so the orchestrator's manifest flow bakes it into a new App in
   * platform and hybrid mode. `null` when the Platform has no public webhook
   * base.
   */
  githubWebhookUrl: z.string().nullable(),
});

/** Auth failure response sent by Platform to orchestrator when authentication fails. */
export const authFailureSchema = z.object({
  type: z.literal('auth.failure'),
  reason: z.string(),
});

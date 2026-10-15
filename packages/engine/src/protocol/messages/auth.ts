import { z } from 'zod';
import { orchCapabilitiesSchema } from './capabilities.js';

// --- Auth protocol messages (orchestrator ↔ Platform WebSocket handshake) ---

/** Auth request sent by orchestrator to Platform when connecting via WebSocket. */
export const authRequestSchema = z.object({
  type: z.literal('auth.request'),
  token: z.string().min(1),
  protocolVersion: z.number().int().positive(),
  capabilities: orchCapabilitiesSchema,
});

/** Auth success response sent by Platform to orchestrator. */
export const authSuccessSchema = z.object({
  type: z.literal('auth.success'),
  connectionId: z.string(),
  /**
   * Public alias of the owning org (`oal_<12-char>`). The check-run emitter
   * builds `details_url` from it via the dashboard's resolver route, so the
   * canonical `org_<12-char>` id never appears in public URLs.
   */
  orgPublicAlias: z.string(),
  /**
   * Canonical id (`org_<…>`) of the owning org. The orchestrator provisions a
   * `remote_sources` anchor (`remote:<orgId>`) from it, so a Platform-relayed
   * `kici run remote` resolves the real tenant.
   */
  orgId: z.string(),
  /**
   * The Platform's org-scoped GitHub App webhook URL
   * (`<WEBHOOK_PUBLIC_URL>/webhook/<orgId>/github`), known before any App
   * exists, so the manifest flow bakes it into a new App in platform and hybrid
   * mode. `null` when the Platform has no public webhook base.
   */
  githubWebhookUrl: z.string().nullable(),
});

/** Auth failure response sent by Platform to orchestrator when authentication fails. */
export const authFailureSchema = z.object({
  type: z.literal('auth.failure'),
  reason: z.string(),
});

import { z } from 'zod';
import { orchCapabilitiesSchema } from './capabilities.js';

// --- Auth protocol messages ---
// Used during WebSocket connection establishment between orchestrator and Platform.

/** Auth request sent by orchestrator to Platform when connecting via WebSocket. */
export const authRequestSchema = z.object({
  type: z.literal('auth.request'),
  token: z.string().min(1),
  protocolVersion: z.number().int().positive(),
  /** Orchestrator capabilities (optional for backward compat with pre-capability orchestrators). */
  capabilities: orchCapabilitiesSchema.optional(),
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
   * that reach public surfaces. Optional for back-compat with Platforms
   * that don't yet supply it; when absent, the orchestrator skips
   * `details_url` (preserving today's behaviour).
   */
  orgPublicAlias: z.string().optional(),
  /**
   * Canonical org id (`org_<…>`) of the authenticated orchestrator's owning
   * org. The orchestrator auto-provisions a `remote_sources` anchor
   * (`remote:<orgId>`) from this so `kici run remote` relayed through the
   * Platform resolves the real tenant. Optional for back-compat with Platforms
   * that don't yet supply it; when absent, the orchestrator skips
   * remote-source provisioning.
   */
  orgId: z.string().optional(),
});

/** Auth failure response sent by Platform to orchestrator when authentication fails. */
export const authFailureSchema = z.object({
  type: z.literal('auth.failure'),
  reason: z.string(),
});

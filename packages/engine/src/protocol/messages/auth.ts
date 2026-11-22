import { z } from 'zod';
import { orchCapabilitiesSchema } from './capabilities.js';

// --- Auth protocol messages (orchestrator ↔ Platform WebSocket handshake) ---

/** Auth request sent by orchestrator to Platform when connecting via WebSocket. */
export const authRequestSchema = z.object({
  type: z.literal('auth.request'),
  token: z.string().min(1),
  protocolVersion: z.number().int().positive(),
  capabilities: orchCapabilitiesSchema,
  /**
   * The sender's release (`0.30.0-4512`). Optional: older releases send none. Any value parses,
   * as it did before the field existed, so no value can refuse a handshake. A reader uses it only
   * when it is a string of at most `COMPONENT_VERSION_MAX_LENGTH` characters that matches
   * `RELEASE_VERSION_PATTERN` (`readComponentVersion`), and treats anything else as absent.
   */
  componentVersion: z.unknown().optional(),
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
  /**
   * The Platform's public dashboard base (e.g. `https://app.kici.dev`). The
   * orchestrator builds the `details_url` of its GitHub check runs from it unless
   * `KICI_DASHBOARD_URL` overrides it. Absent when the Platform has no public
   * base. A plain string, so an odd value yields an odd link, never a refused
   * handshake.
   */
  dashboardUrl: z.string().optional(),
  /**
   * The headless GitHub App manifest page this Platform serves, when it serves
   * one. Absent otherwise. `kici-admin source add github --manifest
   * --no-browser` reads it through the orchestrator's manifest pre-flight and
   * prints it in place of the default page. A plain string, like
   * `dashboardUrl`, so an odd value never refuses the handshake.
   */
  githubManifestCallbackUrl: z.string().optional(),
});

/** Auth failure response sent by Platform to orchestrator when authentication fails. */
export const authFailureSchema = z.object({
  type: z.literal('auth.failure'),
  reason: z.string(),
});

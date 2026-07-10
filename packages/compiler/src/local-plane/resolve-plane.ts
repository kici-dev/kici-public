/**
 * Plane auto-selection for `kici run --local` (design §5).
 *
 * Rules:
 * - `--offline`   → force the independent (offline) plane.
 * - `--connected` → require an attached plane; hard-error if not attached, and
 *   hard-error if the Platform is unreachable (the user explicitly demanded it).
 * - neither flag  → attached + Platform reachable → hybrid; attached but the
 *   Platform is unreachable → fall back to the independent plane with a loud
 *   banner; not attached → offline.
 *
 * The fallback is the "mid-session Platform-unreachable" guarantee: a `--local`
 * run never fails just because the Platform is unreachable (unless `--connected`).
 * It re-boots/keeps the independent plane and continues on local secrets +
 * dev-signed identity.
 */

import { planeUp, readAttachment, readPlatformToken, type PlaneStatus } from './plane-manager.js';
import { probePlatformReachable } from './platform-attach.js';

export interface ResolvePlaneFlags {
  offline?: boolean;
  connected?: boolean;
}

export type ResolvedPlane =
  | { kind: 'offline'; plane: PlaneStatus }
  | { kind: 'attached'; plane: PlaneStatus; orgId: string }
  | { kind: 'fallback'; plane: PlaneStatus; reason: string }
  | { error: string };

/** Boot the hybrid plane from the durable attachment record + persisted token. */
async function bootAttached(attachment: {
  platformWsUrl: string;
  platformApiBase: string;
  orgId: string;
  keyId: string;
}): Promise<PlaneStatus | { error: string }> {
  const token = readPlatformToken();
  if (!token) {
    return {
      error:
        'The plane is attached but its Platform token is missing — run `kici local attach` to re-attach.',
    };
  }
  return planeUp({
    attach: {
      platformWsUrl: attachment.platformWsUrl,
      platformToken: token,
      platformApiBase: attachment.platformApiBase,
      orgId: attachment.orgId,
      keyId: attachment.keyId,
    },
  });
}

export async function resolvePlaneForRun(flags: ResolvePlaneFlags): Promise<ResolvedPlane> {
  const attachment = readAttachment();

  // --offline: force independent regardless of attachment state.
  if (flags.offline) {
    return { kind: 'offline', plane: await planeUp() };
  }

  // --connected: require an attached plane and a reachable Platform.
  if (flags.connected) {
    if (!attachment) {
      return {
        error: 'Not attached to the Platform. Run `kici local attach` first (or drop --connected).',
      };
    }
    if (!(await probePlatformReachable(attachment.platformApiBase))) {
      return {
        error: `Platform ${attachment.platformApiBase} is unreachable — cannot honor --connected.`,
      };
    }
    const booted = await bootAttached(attachment);
    if ('error' in booted) return booted;
    return { kind: 'attached', plane: booted, orgId: attachment.orgId };
  }

  // Auto-select.
  if (!attachment) {
    return { kind: 'offline', plane: await planeUp() };
  }
  if (await probePlatformReachable(attachment.platformApiBase)) {
    const booted = await bootAttached(attachment);
    // A boot error (e.g. missing token) degrades to offline rather than failing.
    if ('error' in booted) {
      return { kind: 'fallback', plane: await planeUp(), reason: booted.error };
    }
    return { kind: 'attached', plane: booted, orgId: attachment.orgId };
  }
  // Attached but the Platform is unreachable → loud fallback to offline.
  return {
    kind: 'fallback',
    plane: await planeUp(),
    reason: 'Platform unreachable',
  };
}

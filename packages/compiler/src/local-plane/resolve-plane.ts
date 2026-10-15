/**
 * Plane selection for `kici run --local`:
 * - `--offline`   → the independent plane.
 * - `--connected` → hard-error unless attached and the Platform is reachable.
 * - neither flag  → attached and reachable → hybrid; attached but unreachable
 *   (or a hybrid boot error) → the independent plane with a loud banner; not
 *   attached → offline.
 *
 * So a `--local` run never fails just because the Platform is unreachable; it
 * continues on local secrets and dev-signed identity.
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

  if (flags.offline) {
    return { kind: 'offline', plane: await planeUp() };
  }

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

  if (!attachment) {
    return { kind: 'offline', plane: await planeUp() };
  }
  if (await probePlatformReachable(attachment.platformApiBase)) {
    const booted = await bootAttached(attachment);
    if ('error' in booted) {
      return { kind: 'fallback', plane: await planeUp(), reason: booted.error };
    }
    return { kind: 'attached', plane: booted, orgId: attachment.orgId };
  }
  return {
    kind: 'fallback',
    plane: await planeUp(),
    reason: 'Platform unreachable',
  };
}

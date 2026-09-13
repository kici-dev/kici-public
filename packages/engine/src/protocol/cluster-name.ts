/**
 * Cluster name format for orchestrator identity.
 *
 * Subpath export: consumers import from
 * `@kici-dev/engine/protocol/cluster-name`. Pure Zod + plain TypeScript
 * with no node built-ins; browser-safe.
 *
 * Three audiences validate against the same regex:
 *   - Orchestrator: boot resolver + `kici-admin cluster-name set`.
 *   - Platform: `source.register` defense-in-depth on wire payload.
 *   - Dashboard: client-side input validation on future rename UI.
 *
 * DNS-label-ish: lowercase letters, digits, hyphens; starts with a
 * letter; max 63 chars. Matches RFC 1035 label rules narrowed to
 * lowercase, which keeps cluster names safe for URLs without encoding
 * and for filesystem / log identifiers.
 */
import { z } from 'zod';

export const CLUSTER_NAME_REGEX = /^[a-z][a-z0-9-]{0,62}$/;

export const CLUSTER_NAME_MAX_LENGTH = 63;

export const CLUSTER_NAME_FORMAT_MESSAGE =
  'Cluster name must match ^[a-z][a-z0-9-]{0,62}$ ' +
  '(lowercase letters, digits, hyphens; start with a letter; ≤63 chars)';

export const clusterNameSchema = z
  .string()
  .min(1, CLUSTER_NAME_FORMAT_MESSAGE)
  .max(CLUSTER_NAME_MAX_LENGTH, CLUSTER_NAME_FORMAT_MESSAGE)
  .regex(CLUSTER_NAME_REGEX, CLUSTER_NAME_FORMAT_MESSAGE);

export type ClusterName = z.infer<typeof clusterNameSchema>;

/**
 * Generate a random auto-name in the `cluster-<6hex>` form used when an
 * operator has not supplied a name. The 6-hex suffix gives ~16M values
 * per org; same-org collisions are caught by the Platform's UNIQUE
 * constraint and the orch retries with a fresh suffix.
 *
 * Accepts an injected `randomBytes` to keep the function testable and
 * to allow the orchestrator caller to use `node:crypto.randomBytes`
 * without pulling a node built-in into this browser-safe module.
 */
export function generateClusterName(randomBytes: (size: number) => Uint8Array): ClusterName {
  const bytes = randomBytes(3);
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  const candidate = `cluster-${hex}`;
  return clusterNameSchema.parse(candidate);
}

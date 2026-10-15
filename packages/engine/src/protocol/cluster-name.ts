/**
 * Cluster name format for orchestrator identity.
 *
 * Subpath export (`@kici-dev/engine/protocol/cluster-name`); browser-safe.
 *
 * Three audiences validate against the same regex:
 *   - Orchestrator: boot resolver + `kici-admin cluster-name set`.
 *   - Platform: `source.register` defense-in-depth on wire payload.
 *   - Dashboard: client-side input validation on future rename UI.
 *
 * RFC 1035 label rules narrowed to lowercase (letters, digits, hyphens;
 * starts with a letter; max 63 chars), so cluster names are safe in URLs
 * without encoding and in filesystem / log identifiers.
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
 * Generate a random `cluster-<6hex>` auto-name for an operator who supplied
 * none. The suffix gives ~16M values per org; the Platform's UNIQUE
 * constraint catches a same-org collision and the orchestrator retries with
 * a fresh suffix.
 *
 * `randomBytes` is injected so the function is testable and the orchestrator can pass
 * `node:crypto.randomBytes` without a Node built-in in this browser-safe module.
 */
export function generateClusterName(randomBytes: (size: number) => Uint8Array): ClusterName {
  const bytes = randomBytes(3);
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  const candidate = `cluster-${hex}`;
  return clusterNameSchema.parse(candidate);
}

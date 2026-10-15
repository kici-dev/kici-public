import type { Kysely } from 'kysely';
import { createLogger, toErrorMessage } from '@kici-dev/shared';
import { canonicalizeCapability } from '@kici-dev/engine';
import type { Database } from '../db/types.js';

const logger = createLogger({ prefix: 'sandbox-allowlist' });

/** The safe deny-all posture used when nothing is configured or the DB errors. */
const DENY_ALL: SandboxAllowList = { capabilities: [], allowHostNetwork: false };

/**
 * The operator-controlled per-org escape-hatch allow-list. `capabilities` are
 * stored canonicalized (bare uppercase Docker-API form) so the dispatch resolver
 * compares canonical-to-canonical.
 */
export interface SandboxAllowList {
  capabilities: string[];
  allowHostNetwork: boolean;
}

export interface SandboxAllowListReader {
  /**
   * Never throws: a DB error or no DB handle degrades to deny-all, so a sick DB
   * denies escalation rather than blocking dispatch.
   */
  read(orgId: string): Promise<SandboxAllowList>;
}

/**
 * Reader for the per-org container-sandbox escape-hatch allow-list, read once per
 * matched-workflow dispatch against one indexed row. Intentionally **uncached**:
 * a security control, so an operator's `sandbox-allowlist` change must apply on
 * the very next dispatch; a cache TTL would open a stale-deny or stale-allow
 * window on a privilege boundary.
 */
export function createSandboxAllowListReader(deps: {
  db?: Kysely<Database>;
}): SandboxAllowListReader {
  const { db } = deps;

  return {
    async read(orgId: string): Promise<SandboxAllowList> {
      if (!db) return DENY_ALL;
      try {
        const row = await db
          .selectFrom('org_settings')
          .select(['sandbox_allowed_capabilities', 'sandbox_allow_host_network'])
          .where('customer_id', '=', orgId)
          .executeTakeFirst();
        const capabilities = (row?.sandbox_allowed_capabilities ?? []).map(canonicalizeCapability);
        const allowHostNetwork = row?.sandbox_allow_host_network === true;
        return { capabilities, allowHostNetwork };
      } catch (err) {
        // DB-degraded: deny all escalation (fail-safe) rather than blocking.
        logger.warn('sandbox allow-list reader degraded to deny-all', {
          orgId,
          error: toErrorMessage(err),
        });
        return DENY_ALL;
      }
    },
  };
}

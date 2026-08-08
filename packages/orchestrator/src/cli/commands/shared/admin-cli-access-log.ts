/**
 * Shared access-log recorder for the direct-DB kici-admin subcommands.
 *
 * The mutating db / host subcommands act straight against Postgres (bypassing
 * the orchestrator HTTP admin API), so without this they would leave no
 * `access_log` trail — unlike the HTTP/WS admin path. This helper records one
 * `admin_cli`-source row per mutation, attributed to a service_account actor
 * derived from the operator's OS identity, so the audit story is identical
 * regardless of transport.
 *
 * Best-effort by design: the orchestrator access_log is a broad audit stream
 * whose writer swallows insert failures so a broken audit table can never take
 * down an admin command. This recorder inherits that contract.
 */

import os from 'node:os';
import type { Kysely } from 'kysely';
import { createLogger, toErrorMessage } from '@kici-dev/shared';
import {
  AccessLogSource,
  type AccessLogAction,
  type AccessLogOutcome,
  type AccessLogTargetType,
  type ServiceAccountActor,
} from '@kici-dev/engine';
import type { Database } from '../../../db/types.js';
import { AccessLogWriter } from '../../../audit/access-log.js';
import { createDb, createPool } from '../../../db/client.js';

const logger = createLogger({ prefix: 'admin-cli-access-log' });

export interface AdminCliAccessEntry {
  action: AccessLogAction;
  target: { type: AccessLogTargetType; id: string } | null;
  outcome: AccessLogOutcome;
  errorMessage?: string | null;
  meta?: Record<string, unknown>;
  orgId?: string | null;
  routingKey?: string | null;
}

/**
 * The actor for a bare-metal CLI operator. There is no Keycloak sub on the
 * box, so we attribute to a service_account keyed on the OS identity — the
 * same actor family the HTTP CLI-driven admin routes use.
 */
export function adminCliActor(): ServiceAccountActor {
  let username = 'unknown';
  try {
    username = os.userInfo().username || 'unknown';
  } catch {
    // os.userInfo() can throw when there is no passwd entry (rare container
    // setups); fall back to the env or 'unknown'.
    username = process.env.USER || 'unknown';
  }
  return { type: 'service_account', id: `${username}@${os.hostname()}` };
}

/** Record on an already-open orchestrator-DB Kysely handle. Never throws. */
export async function recordAdminCliAccessOnDb(
  db: Kysely<Database>,
  entry: AdminCliAccessEntry,
): Promise<void> {
  try {
    await new AccessLogWriter(db).record({
      orgId: entry.orgId ?? null,
      routingKey: entry.routingKey ?? null,
      actor: adminCliActor(),
      action: entry.action,
      target: entry.target,
      requestId: null,
      source: AccessLogSource.enum.admin_cli,
      outcome: entry.outcome,
      errorMessage: entry.errorMessage ?? null,
      meta: entry.meta,
    });
  } catch (err) {
    logger.warn('admin_cli access-log record failed', {
      action: entry.action,
      error: toErrorMessage(err),
    });
  }
}

/**
 * Open a short-lived connection to the orchestrator's own DB (auditDbUrl, or
 * KICI_DATABASE_URL) and record there. Used by the provisioning subcommands
 * whose own connection targets a schemaless / admin DB with no access_log
 * table. A best-effort no-op when no URL resolves (pure bootstrap): the
 * subcommand's stderr banner is the audit floor in that case.
 */
export async function recordAdminCliAccess(
  entry: AdminCliAccessEntry,
  auditDbUrl?: string,
): Promise<void> {
  const url = auditDbUrl ?? process.env.KICI_DATABASE_URL;
  if (!url) return;
  const pool = createPool(url);
  const db = createDb(pool);
  try {
    await recordAdminCliAccessOnDb(db, entry);
  } finally {
    await db.destroy().catch(() => undefined);
    await pool.end().catch(() => undefined);
  }
}

/**
 * Access-log recorder for the direct-DB kici-admin subcommands, which bypass
 * the HTTP admin API and would otherwise leave no `access_log` trail. It writes
 * one `admin_cli` row per mutation, attributed to the operator's OS identity.
 *
 * Best-effort, like the access_log writer: a broken audit table never takes
 * down an admin command.
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
 * No Keycloak sub exists on the box, so the actor is a service_account keyed
 * on the OS identity, as the HTTP CLI-driven admin routes use.
 */
export function adminCliActor(): ServiceAccountActor {
  let username = 'unknown';
  try {
    username = os.userInfo().username || 'unknown';
  } catch {
    // Throws without a passwd entry (some containers).
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
 * Record through a short-lived connection to the orchestrator DB, for
 * provisioning subcommands whose own DB has no access_log table. A no-op with
 * no URL (pure bootstrap), where the stderr banner is the audit floor.
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

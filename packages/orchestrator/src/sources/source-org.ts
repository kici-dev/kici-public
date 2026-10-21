/**
 * Which org a GitHub source belongs to.
 *
 * A source's `customer_id` decides the org of every registration and run it
 * produces, so it decides which contexts, secrets and trust policy those runs
 * use. On a Platform-attached orchestrator that org is the attached one: the
 * Platform, the dashboard and `kici compile` all point the operator there.
 */
import type { Kysely, Transaction } from 'kysely';
import type { Database } from '../db/types.js';
import { PlatformAttachment } from '../db/repos/org-ids-repo.js';

export type NewSourceOrg =
  { ok: true; orgId: string } | { ok: false; status: 400 | 503; error: string };

/** The run-org consequence of filing a source under an org other than the attached one. */
export const FOREIGN_ORG_CONSEQUENCE =
  "A source filed under another org runs under that org's contexts, secrets and trust " +
  'policy, not the ones the Platform and the dashboard manage.';

/**
 * Decide the org of a new source from the requested org and the Platform
 * attachment.
 *
 * - attached: no request, or the attached org itself, files under the
 *   attached org; any other org is refused (400).
 * - pending: the attached org is not known yet, so an explicit org is
 *   accepted and a missing one is refused (503) rather than guessed.
 * - none (an independent orchestrator): the requested org, or `__default__`.
 */
export function resolveNewSourceOrg(input: {
  requested: string | undefined;
  attachment: { platformAttachment: PlatformAttachment; attachedOrgId: string | null };
}): NewSourceOrg {
  const { requested, attachment } = input;
  switch (attachment.platformAttachment) {
    case PlatformAttachment.enum.attached: {
      const attached = attachment.attachedOrgId!;
      if (requested === undefined || requested === attached) return { ok: true, orgId: attached };
      return {
        ok: false,
        status: 400,
        error:
          `orgId "${requested}" does not match this orchestrator's Platform organization ` +
          `"${attached}". ${FOREIGN_ORG_CONSEQUENCE} Re-run with --org ${attached}, or leave ` +
          '--org out.',
      };
    }
    case PlatformAttachment.enum.pending:
      if (requested !== undefined) return { ok: true, orgId: requested };
      return {
        ok: false,
        status: 503,
        error:
          'This orchestrator has not authenticated with the Platform yet, so it cannot tell ' +
          'which org the source belongs to. Retry once kici-admin orchestrator status shows the ' +
          'org, or pass --org <orgId>.',
      };
    case PlatformAttachment.enum.none:
      return { ok: true, orgId: requested ?? '__default__' };
  }
}

/**
 * Move every registration of a source to `orgId`, and bump the registry
 * version when any row moved so every peer reloads its registration index.
 * Run it in the same transaction as the `sources` update that changed the org:
 * a source and its registrations must never disagree on the org.
 *
 * Returns the number of registrations moved.
 */
export async function rehomeSourceRegistrations(
  trx: Kysely<Database> | Transaction<Database>,
  routingKey: string,
  orgId: string,
): Promise<number> {
  const result = await trx
    .updateTable('workflow_registrations')
    .set({ customer_id: orgId, updated_at: new Date() })
    .where('routing_key', '=', routingKey)
    .where('customer_id', '<>', orgId)
    .executeTakeFirst();
  const moved = Number(result.numUpdatedRows);
  if (moved > 0) {
    await trx
      .updateTable('registry_versions')
      .set((eb) => ({ version: eb('version', '+', 1), updated_at: new Date() }))
      .where('id', '=', 'default')
      .execute();
  }
  return moved;
}

/**
 * Set a source's org and move its registrations with it, in one transaction.
 * Returns false when no source has the routing key.
 */
export async function moveSourceToOrg(
  db: Kysely<Database>,
  routingKey: string,
  orgId: string,
): Promise<boolean> {
  return db.transaction().execute(async (trx) => {
    const res = await trx
      .updateTable('sources')
      .set({ customer_id: orgId, updated_at: new Date() })
      .where('routing_key', '=', routingKey)
      .executeTakeFirst();
    if (Number(res.numUpdatedRows) === 0) return false;
    await rehomeSourceRegistrations(trx, routingKey, orgId);
    return true;
  });
}

/**
 * Per-job facts the git credential relay needs, read from server truth.
 *
 * The relay never takes the org or the source repository from request params —
 * an agent could name any repository it liked. Both come from the run row the
 * orchestrator itself wrote at dispatch.
 */

import type { Kysely } from 'kysely';
import type { Database } from '../db/types.js';
import type { JobCredentialContext } from '../ws/git-credential-relay.js';

/** Build the `jobContext` lookup the git credential handler takes. */
export function createJobCredentialContextReader(db: Kysely<Database>) {
  return async (runId: string): Promise<JobCredentialContext | null> => {
    const row = await db
      .selectFrom('execution_runs')
      .select(['customer_id', 'repo_identifier'])
      .where('run_id', '=', runId)
      .executeTakeFirst();

    if (!row) return null;
    return { orgId: row.customer_id, sourceRepo: row.repo_identifier };
  };
}

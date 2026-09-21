/**
 * Per-job facts the git credential relay needs, read from server truth.
 *
 * The relay never takes any of these from request params — an agent could name
 * any repository, declare any credential, and claim any trust tier it liked.
 * Every field comes from rows the orchestrator itself wrote at dispatch: the
 * run row for the org, the repository, the branch, the trigger and the
 * contributor's trust tier, and the dispatch record for the credentials the
 * job's lock entry declared.
 */

import type { Kysely } from 'kysely';
import type { TrustTier } from '@kici-dev/engine';
import { TrustTierSchema } from '@kici-dev/engine';
import type { Database } from '../db/types.js';
import type { JobCredentialContext } from '../ws/git-credential-relay.js';

/** The `gitCredentials` map shape shared by the lock, the wire and both rows. */
type DeclaredCredentials = Record<string, Record<string, string>>;

/**
 * Read a persisted `trust_tier` back as a tier, or `undefined`.
 *
 * SQL NULL is what a non-pull-request run legitimately carries, and `undefined`
 * is the lenient reading everywhere else in the orchestrator (see
 * `security/trust-tier.ts`). A NON-null value the schema does not recognize is
 * a tier the run DID carry, in a vocabulary this orchestrator no longer reads —
 * a row written before the tier set narrowed holds `known`, which meant "not
 * trusted". Reading that as `undefined` would be a fail-open: the relay's
 * `isUntrustedTier(undefined)` is `false`, so a once-untrusted run would be
 * handed credentials it was denied when it ran. So it reads as `unknown`, the
 * strict tier — the same mapping the internal-event pipeline applies.
 */
function parseTrustTier(raw: string | null): TrustTier | undefined {
  if (raw === null) return undefined;
  const parsed = TrustTierSchema.safeParse(raw);
  return parsed.success ? parsed.data : TrustTierSchema.enum.unknown;
}

/** `dispatch_queue.id` is a uuid column, so anything else was never a row in it. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Keep only entries that are flat string maps.
 *
 * `job_config` is stored as text and parsed back here, so its shape is asserted
 * rather than assumed. `refMatchesDeclared` compares a wire ref field-by-field
 * against an entry, so an entry carrying a nested object or a number could
 * never match one anyway — dropping it keeps the comparison total.
 */
function asDeclaredCredentials(raw: unknown): DeclaredCredentials | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const out: DeclaredCredentials = {};
  for (const [name, entry] of Object.entries(raw as Record<string, unknown>)) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const fields = Object.entries(entry as Record<string, unknown>);
    if (!fields.every(([, v]) => typeof v === 'string')) continue;
    out[name] = Object.fromEntries(fields) as Record<string, string>;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * The declaration as it was written into the job's DISPATCH record.
 *
 * This is the copy that exists before the agent can act on the job. The
 * pipeline sends the dispatch first and persists `execution_jobs` afterwards
 * (`recordRunStart` runs once the whole dispatch loop has finished), so an
 * agent whose first credential request lands inside that window finds no job
 * row at all — and a missing row read as "declared nothing" refuses a
 * credential the workflow correctly declared. `dispatch_queue` is written by
 * `insertDispatched` / `enqueue` BEFORE `onDispatch` puts the job on the wire,
 * so by the time any agent can ask, this row is there.
 *
 * It is the same value from the same lock entry that `execution_jobs` receives
 * — `buildJobConfig` and the tracked row both copy `lockJob.gitCredentials`
 * verbatim — and nothing an agent sends ever reaches it, so reading it can
 * admit exactly what the lock declared and nothing more.
 */
async function declaredFromDispatchRecord(
  db: Kysely<Database>,
  jobId: string,
): Promise<DeclaredCredentials | undefined> {
  if (!UUID.test(jobId)) return undefined;
  const row = await db
    .selectFrom('dispatch_queue')
    .select('job_config')
    .where('id', '=', jobId)
    .executeTakeFirst();
  if (!row?.job_config) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(row.job_config);
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== 'object') return undefined;
  return asDeclaredCredentials((parsed as Record<string, unknown>).gitCredentials);
}

/** Build the `jobContext` lookup the git credential handler takes. */
export function createJobCredentialContextReader(db: Kysely<Database>) {
  return async (runId: string, jobId: string): Promise<JobCredentialContext | null> => {
    const run = await db
      .selectFrom('execution_runs')
      .select(['customer_id', 'repo_identifier', 'ref', 'trigger_event', 'trust_tier'])
      .where('run_id', '=', runId)
      .executeTakeFirst();

    if (!run) return null;

    // The job row may legitimately be absent — `addJobsToRun` runs after the
    // dispatch loop, so the agent can ask before it lands. The relay has
    // already proved the agent owns THIS job id via the dispatcher, so the
    // absence says nothing about the declaration; the dispatch record below is
    // what answers it.
    const job = await db
      .selectFrom('execution_jobs')
      .select('git_credentials')
      .where('run_id', '=', runId)
      .where('job_id', '=', jobId)
      .executeTakeFirst();

    // Both rows carry the same lock entry, so the order is a freshness
    // preference, not a policy choice: the tracked row when it is there,
    // otherwise the dispatch record. Neither can name a credential the lock did
    // not declare, so the fallback admits nothing extra — it only stops a
    // declared one being refused during the window before the tracked row
    // exists. Nothing found anywhere stays "declared nothing", which refuses
    // every workflow-supplied ref.
    const declaredCredentials =
      asDeclaredCredentials(job?.git_credentials) ?? (await declaredFromDispatchRecord(db, jobId));

    return {
      orgId: run.customer_id,
      sourceRepo: run.repo_identifier,
      declaredCredentials: declaredCredentials ?? {},
      trustTier: parseTrustTier(run.trust_tier),
      // `execution_runs.ref` is the branch the run PRESENTS — the same value
      // `event.targetBranch` carried into the dispatch-time protection gates,
      // not a job's checkout ref.
      branch: run.ref,
      triggerType: run.trigger_event ?? '',
    };
  };
}

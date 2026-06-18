/**
 * Secret output store for cross-job secret output CRUD.
 *
 * Provides typed operations against the run_secret_outputs table:
 * - Upsert encrypted secret outputs (per run/job/key)
 * - Retrieve outputs for a specific job or multiple upstream jobs
 * - Delete all outputs for a run (cleanup)
 * - Delete orphaned outputs older than a threshold (maintenance)
 */
import type { Kysely } from 'kysely';
import type { Database } from '../db/types.js';

export class SecretOutputStore {
  constructor(private readonly db: Kysely<Database>) {}

  /**
   * Store an encrypted secret output (upsert).
   * If (run_id, job_id, output_key) already exists, the value is updated.
   */
  async storeSecretOutput(
    runId: string,
    jobId: string,
    outputKey: string,
    encryptedValue: string,
  ): Promise<void> {
    await this.db
      .insertInto('run_secret_outputs')
      .values({
        run_id: runId,
        job_id: jobId,
        output_key: outputKey,
        encrypted_value: encryptedValue,
      })
      .onConflict((oc) =>
        oc.columns(['run_id', 'job_id', 'output_key']).doUpdateSet({
          encrypted_value: encryptedValue,
        }),
      )
      .execute();
  }

  /**
   * Get all secret outputs for a specific job in a run.
   *
   * @returns Record mapping output_key -> encrypted_value
   */
  async getSecretOutputs(runId: string, jobId: string): Promise<Record<string, string>> {
    const rows = await this.db
      .selectFrom('run_secret_outputs')
      .selectAll()
      .where('run_id', '=', runId)
      .where('job_id', '=', jobId)
      .execute();

    const result: Record<string, string> = {};
    for (const row of rows) {
      result[row.output_key] = row.encrypted_value;
    }
    return result;
  }

  /**
   * Get secret outputs from multiple upstream jobs.
   *
   * @returns Record mapping jobId -> Record<output_key, encrypted_value>
   */
  async getUpstreamSecretOutputs(
    runId: string,
    jobIds: string[],
  ): Promise<Record<string, Record<string, string>>> {
    if (jobIds.length === 0) {
      return {};
    }

    const rows = await this.db
      .selectFrom('run_secret_outputs')
      .selectAll()
      .where('run_id', '=', runId)
      .where('job_id', 'in', jobIds)
      .execute();

    const result: Record<string, Record<string, string>> = {};
    for (const row of rows) {
      if (!result[row.job_id]) {
        result[row.job_id] = {};
      }
      result[row.job_id][row.output_key] = row.encrypted_value;
    }
    return result;
  }

  /**
   * Delete all secret outputs for a run.
   *
   * @returns Number of rows deleted
   */
  async deleteByRunId(runId: string): Promise<number> {
    const result = await this.db
      .deleteFrom('run_secret_outputs')
      .where('run_id', '=', runId)
      .execute();

    return Number(result[0]?.numDeletedRows ?? 0n);
  }

  /**
   * Delete orphaned secret outputs older than maxAgeHours.
   * Used for periodic cleanup of outputs from completed/abandoned runs.
   *
   * @returns Number of rows deleted
   */
  async cleanupOrphaned(maxAgeHours: number): Promise<number> {
    const cutoff = new Date(Date.now() - maxAgeHours * 60 * 60 * 1000);

    const result = await this.db
      .deleteFrom('run_secret_outputs')
      .where('created_at', '<', cutoff)
      .execute();

    return Number(result[0]?.numDeletedRows ?? 0n);
  }
}

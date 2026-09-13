/**
 * Persistence of the webhook payload that started a run.
 *
 * The payload is what the dashboard's Payload tab reads and what a re-run
 * copies onto the new run, so every dispatch path that creates a run from an
 * inbound event must write it. It lives here rather than inline in one
 * dispatcher because there is more than one such path — the per-repository
 * dispatch and both organization-wide (global) dispatch paths — and a run
 * whose path forgot to write it is indistinguishable from a run whose payload
 * was never stored at all.
 */
import { createLogger, toErrorMessage } from '@kici-dev/shared';
import type { LogStorage } from '../reporting/log-storage.js';

// `pipeline`, not this module's own name: both call sites — the per-repository
// dispatch and the organization-wide one — already log under that prefix, so
// keeping it means an existing log selector keyed on it still matches every
// line this helper emits.
const logger = createLogger({ prefix: 'pipeline' });

/**
 * Object-storage key holding the webhook payload for a run. Shared by the
 * writers and by the re-run path that copies a payload forward, so the layout
 * is stated once.
 */
export function webhookPayloadPath(runId: string): string {
  return `executions/${runId}/webhook-payload.json`;
}

/**
 * Store a run's triggering webhook payload, best-effort.
 *
 * A failure is logged and swallowed: the payload is a debugging aid, and losing
 * it must never cost the run that was about to execute. A no-op when the
 * orchestrator has no object storage configured.
 */
export async function storeWebhookPayload(args: {
  logStorage: LogStorage | undefined;
  runId: string;
  payload: unknown;
}): Promise<void> {
  const { logStorage, runId, payload } = args;
  if (!logStorage) return;
  const payloadPath = webhookPayloadPath(runId);
  const payloadBytes = JSON.stringify(payload);
  const backend = logStorage.constructor.name;
  try {
    await logStorage.append(payloadPath, payloadBytes);
    logger.info('Stored webhook payload for run', {
      runId,
      payloadPath,
      bytes: payloadBytes.length,
      logStorageBackend: backend,
    });
  } catch (err) {
    logger.error('Failed to store webhook payload', {
      runId,
      payloadPath,
      bytes: payloadBytes.length,
      logStorageBackend: backend,
      error: toErrorMessage(err),
    });
  }
}

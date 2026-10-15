/**
 * Persistence of the webhook payload that started a run.
 *
 * The dashboard's Payload tab reads it and a re-run copies it forward, so every
 * dispatch path that creates a run from an inbound event (per-repository and
 * both organization-wide paths) must write it: a path that forgot looks the
 * same as a payload never stored.
 */
import { createLogger, toErrorMessage } from '@kici-dev/shared';
import type { LogStorage } from '../reporting/log-storage.js';

// `pipeline`, not this module's name: both call sites log under that prefix,
// so an existing log selector keyed on it still matches this helper's lines.
const logger = createLogger({ prefix: 'pipeline' });

/** Object-storage key of a run's webhook payload, shared by the writers and the re-run copy. */
export function webhookPayloadPath(runId: string): string {
  return `executions/${runId}/webhook-payload.json`;
}

/**
 * Best-effort: a failure is logged and swallowed, because losing a debugging
 * aid must never cost the run. A no-op without object storage.
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

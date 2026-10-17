/**
 * Validate an outbound status frame before it leaves for the Platform.
 *
 * The execution-status family carries agent- and user-authored text. A frame
 * the Platform cannot accept costs this connection a strike and loses the
 * update, so it is refused here, logged by field path, and never sent. A valid
 * frame is replaced by the schema's parsed output, which carries clamped free
 * text. Other frames (`log.chunk` is high volume) are returned unchanged.
 */
import type { ZodType } from 'zod';
import {
  executionStatusSchema,
  invalidFramePaths,
  jobStatusForwardSchema,
  stateReplaySchema,
  stepStatusForwardSchema,
  type OrchestratorToPlatformMessage,
} from '@kici-dev/engine';
import { createLogger } from '@kici-dev/shared';

const logger = createLogger({ prefix: 'platform-client' });

const GUARDED_SCHEMAS: ReadonlyMap<string, ZodType> = new Map<string, ZodType>([
  ['execution.status', executionStatusSchema],
  ['job.status.forward', jobStatusForwardSchema],
  ['step.status.forward', stepStatusForwardSchema],
  ['state.replay', stateReplaySchema],
]);

/** The frame to send (clamped for a guarded type), or null when it must not be sent. */
export function guardOutboundFrame(
  frame: OrchestratorToPlatformMessage,
): OrchestratorToPlatformMessage | null {
  const schema = GUARDED_SCHEMAS.get(frame.type);
  if (!schema) return frame;
  const parsed = schema.safeParse(frame);
  if (parsed.success) return parsed.data as OrchestratorToPlatformMessage;
  logger.error('Refusing to send an invalid frame to the Platform', {
    messageType: frame.type,
    paths: invalidFramePaths(parsed.error.issues),
  });
  return null;
}

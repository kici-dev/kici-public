import { z } from 'zod';

/**
 * Scaler lifecycle event types emitted by all backends, stored in event_log for
 * the timeline and relayed worker→coordinator via the scaler.event peer message.
 * The dotted values are the on-wire form the event_log row name and the
 * dashboard timeline depend on; use bracket access:
 * `ScalerEventType.enum['scaler.failed']`.
 */
export const ScalerEventType = z.enum([
  'scaler.provisioning',
  'scaler.network',
  'scaler.ready',
  'scaler.failed',
  'agent.connecting',
]);
export type ScalerEventType = z.infer<typeof ScalerEventType>;

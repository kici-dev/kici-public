import { z } from 'zod';

/**
 * Standardized scaler lifecycle event types emitted by all backends.
 *
 * Stored in the event_log table for timeline rendering and relayed
 * worker→coordinator via the scaler.event peer message. The values are dotted
 * (e.g. "scaler.failed") because that is the on-wire form the event_log row
 * name and the dashboard timeline depend on — access members with bracket
 * notation: `ScalerEventType.enum['scaler.failed']`.
 */
export const ScalerEventType = z.enum([
  'scaler.provisioning',
  'scaler.network',
  'scaler.ready',
  'scaler.failed',
  'agent.connecting',
]);
export type ScalerEventType = z.infer<typeof ScalerEventType>;

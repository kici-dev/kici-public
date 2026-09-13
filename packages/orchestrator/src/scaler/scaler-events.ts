/**
 * Orchestrator-side entry point for the event scaler's event vocabulary.
 *
 * The schemas and constants themselves live in `@kici-dev/engine` so the SDK —
 * the only KiCI package a workflow file may import — shares one source of truth
 * with the emitting side. This module re-exports them (plus the reserved
 * prefix) so orchestrator call sites keep a single local import for the whole
 * vocabulary.
 */

export {
  KICI_EVENT_NAME_PREFIX,
  SCALER_EVENT_NAMES,
  ScaleDownReason,
  ScalerScaleUpPayload,
  ScalerScaleDownPayload,
} from '@kici-dev/engine';

/**
 * Orchestrator-side entry point for the event scaler's event vocabulary.
 *
 * The schemas live in `@kici-dev/engine` so the SDK — the only KiCI package a
 * workflow file may import — shares one source of truth with the emitting side.
 */

export {
  KICI_EVENT_NAME_PREFIX,
  SCALER_EVENT_NAMES,
  ScaleDownReason,
  ScalerScaleUpPayload,
  ScalerScaleDownPayload,
} from '@kici-dev/engine';

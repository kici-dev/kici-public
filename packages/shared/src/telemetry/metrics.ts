import { metrics } from '@opentelemetry/api';

/** An OTel Meter for `serviceName` (e.g. 'orchestrator'). */
export function createMeter(serviceName: string) {
  return metrics.getMeter(serviceName);
}

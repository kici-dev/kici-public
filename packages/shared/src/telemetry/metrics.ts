import { metrics } from '@opentelemetry/api';

/**
 * Create an OTel Meter for a given service.
 *
 * @param serviceName - Name of the service (e.g., 'orchestrator')
 * @returns An OTel Meter instance for creating instruments
 */
export function createMeter(serviceName: string) {
  return metrics.getMeter(serviceName);
}

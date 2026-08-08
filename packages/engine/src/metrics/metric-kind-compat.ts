/**
 * The metric-kind vocabulary shared by the orchestrator's push reporter, the
 * Platform's admission filter, and the runtime-metrics drift guard.
 *
 * The catalog records the OTel instrument kind (`observableGauge`, …) while the
 * wire carries a narrower set, so admission needs a compatibility relation
 * rather than equality. Keeping one implementation is what stops the guard and
 * the runtime path from disagreeing about which series are admissible.
 */

/** Metric kinds that appear on the orchestrator → Platform wire. */
export type WireMetricKind = 'counter' | 'histogram' | 'gauge' | 'upDownCounter';

/**
 * OTel `DataPointType` enum values, mirrored as plain numbers so this module
 * stays dependency-free. `@opentelemetry/sdk-metrics` is not an engine
 * dependency and must not become one.
 */
export const OTEL_DATA_POINT_TYPE = { HISTOGRAM: 0, GAUGE: 2, SUM: 3 } as const;

/** Derive the wire kind from an OTel descriptor's data-point type. */
export function mapDataPointTypeToWireKind(
  dataPointType: number,
  isMonotonic?: boolean,
): WireMetricKind {
  switch (dataPointType) {
    case OTEL_DATA_POINT_TYPE.HISTOGRAM:
      return 'histogram';
    case OTEL_DATA_POINT_TYPE.GAUGE:
      return 'gauge';
    case OTEL_DATA_POINT_TYPE.SUM:
      return isMonotonic === false ? 'upDownCounter' : 'counter';
    default:
      return 'gauge';
  }
}

/** True when a wire kind may be admitted against a catalogued instrument kind. */
export function isCompatibleMetricKind(wire: WireMetricKind, catalog: string): boolean {
  if (wire === catalog) return true;
  if (wire === 'gauge' && catalog === 'observableGauge') return true;
  if (wire === 'counter' && catalog === 'observableCounter') return true;
  if (wire === 'upDownCounter' && catalog === 'observableUpDownCounter') return true;
  return false;
}

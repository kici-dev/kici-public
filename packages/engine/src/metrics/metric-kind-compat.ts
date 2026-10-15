/**
 * Metric kinds shared by the orchestrator's push reporter, the Platform's
 * admission filter and the runtime-metrics drift guard. The catalog records
 * the OTel instrument kind (`observableGauge`, …) while the wire carries a
 * narrower set, so admission uses a compatibility relation, not equality. One
 * implementation keeps the guard and the runtime path agreeing.
 */

/** Metric kinds that appear on the orchestrator → Platform wire. */
export type WireMetricKind = 'counter' | 'histogram' | 'gauge' | 'upDownCounter';

/** OTel `DataPointType` values; `@opentelemetry/sdk-metrics` must not become an engine dep. */
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

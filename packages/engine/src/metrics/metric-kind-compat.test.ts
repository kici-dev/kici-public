import { describe, it, expect } from 'vitest';
import {
  OTEL_DATA_POINT_TYPE,
  isCompatibleMetricKind,
  mapDataPointTypeToWireKind,
} from './metric-kind-compat.js';

describe('mapDataPointTypeToWireKind', () => {
  it('maps histogram and gauge descriptors', () => {
    expect(mapDataPointTypeToWireKind(OTEL_DATA_POINT_TYPE.HISTOGRAM)).toBe('histogram');
    expect(mapDataPointTypeToWireKind(OTEL_DATA_POINT_TYPE.GAUGE)).toBe('gauge');
  });

  it('splits SUM on monotonicity', () => {
    // The live defect: v8js.memory.heap.space.size is SUM + isMonotonic=false,
    // i.e. an upDownCounter, but was catalogued as a gauge and dropped.
    expect(mapDataPointTypeToWireKind(OTEL_DATA_POINT_TYPE.SUM, false)).toBe('upDownCounter');
    expect(mapDataPointTypeToWireKind(OTEL_DATA_POINT_TYPE.SUM, true)).toBe('counter');
    expect(mapDataPointTypeToWireKind(OTEL_DATA_POINT_TYPE.SUM)).toBe('counter');
  });

  it('falls back to gauge for an unknown descriptor type', () => {
    expect(mapDataPointTypeToWireKind(99)).toBe('gauge');
  });
});

describe('isCompatibleMetricKind', () => {
  it('accepts an exact match', () => {
    expect(isCompatibleMetricKind('counter', 'counter')).toBe(true);
  });

  it('accepts the observable catalog spellings', () => {
    // These are why the guard cannot use string equality: the catalog uses the
    // OTel instrument vocabulary, the wire uses the narrower set.
    expect(isCompatibleMetricKind('gauge', 'observableGauge')).toBe(true);
    expect(isCompatibleMetricKind('counter', 'observableCounter')).toBe(true);
    expect(isCompatibleMetricKind('upDownCounter', 'observableUpDownCounter')).toBe(true);
  });

  it('rejects the mismatch that silently dropped a metric in production', () => {
    expect(isCompatibleMetricKind('upDownCounter', 'gauge')).toBe(false);
  });

  it('rejects an unrelated catalog kind', () => {
    expect(isCompatibleMetricKind('gauge', 'histogram')).toBe(false);
  });
});

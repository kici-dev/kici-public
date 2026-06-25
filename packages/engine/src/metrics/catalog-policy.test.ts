import { describe, it, expect } from 'vitest';
import {
  MetricLabels,
  MetricNames,
  MetricService,
  type MetricName,
} from './metric-catalog.generated.js';
import {
  METRIC_LABEL_POLICY,
  ORCH_PUSHED_METRIC_NAMES,
  ORCH_SCALER_VALUES,
  OVERFLOW_LABEL_VALUE,
} from './catalog-policy.js';
import { ExecutionRunStatus } from '../protocol/messages/execution-status.js';

describe('catalog-policy', () => {
  // Services whose metrics the orchestrator is allowed to push: its own,
  // forwarded agent metrics, and the Node runtime metrics it emits via
  // RuntimeNodeInstrumentation (catalog service 'runtime').
  const PUSHED_SERVICES = new Set(['orchestrator', 'agent', 'runtime']);

  it('ORCH_PUSHED_METRIC_NAMES contains every orchestrator, agent, and runtime metric', () => {
    for (const [key, svc] of Object.entries(MetricService)) {
      if (!PUSHED_SERVICES.has(svc)) continue;
      const name = MetricNames[key as keyof typeof MetricNames];
      expect(
        ORCH_PUSHED_METRIC_NAMES.has(name),
        `expected ORCH_PUSHED_METRIC_NAMES to include ${name} (service=${svc})`,
      ).toBe(true);
    }
  });

  it('ORCH_PUSHED_METRIC_NAMES excludes every Platform metric', () => {
    for (const [key, svc] of Object.entries(MetricService)) {
      if (PUSHED_SERVICES.has(svc)) continue;
      const name = MetricNames[key as keyof typeof MetricNames];
      expect(
        ORCH_PUSHED_METRIC_NAMES.has(name),
        `expected ORCH_PUSHED_METRIC_NAMES to exclude ${name} (service=${svc})`,
      ).toBe(false);
    }
  });

  it('every METRIC_LABEL_POLICY entry references a known catalog metric', () => {
    // Platform-emitted metrics can appear here to declare value bounds
    // (closed enums, cardinality caps) on labels they themselves set —
    // they don't need to be orch-pushable. The only hard invariant is
    // that the metric name is in the catalog at all.
    for (const name of Object.keys(METRIC_LABEL_POLICY)) {
      expect(
        Object.values(MetricNames).includes(name as MetricName),
        `METRIC_LABEL_POLICY entry "${name}" is not in MetricNames — every policy entry must reference a real catalog metric`,
      ).toBe(true);
    }
  });

  it('every policy label key is declared in MetricLabels', () => {
    for (const [name, policy] of Object.entries(METRIC_LABEL_POLICY)) {
      const allowedKeys = findMetricLabels(name as MetricName);
      for (const key of Object.keys(policy ?? {})) {
        expect(
          allowedKeys.includes(key),
          `METRIC_LABEL_POLICY[${name}].${key} is not in MetricLabels — auto catalog says this metric carries [${allowedKeys.join(', ')}]`,
        ).toBe(true);
      }
    }
  });

  it('every cap-bounded label declares a positive maxUniqueValues', () => {
    for (const [name, policy] of Object.entries(METRIC_LABEL_POLICY)) {
      for (const [key, spec] of Object.entries(policy ?? {})) {
        if (spec?.maxUniqueValues === undefined) continue;
        expect(spec.maxUniqueValues, `${name}.${key} maxUniqueValues must be > 0`).toBeGreaterThan(
          0,
        );
      }
    }
  });

  it('every enum-bound label declares at least one value', () => {
    for (const [name, policy] of Object.entries(METRIC_LABEL_POLICY)) {
      for (const [key, spec] of Object.entries(policy ?? {})) {
        if (spec?.values === undefined) continue;
        expect(spec.values.length, `${name}.${key} values must be non-empty`).toBeGreaterThan(0);
      }
    }
  });

  it('OVERFLOW_LABEL_VALUE is a stable sentinel', () => {
    expect(OVERFLOW_LABEL_VALUE).toBe('__overflow__');
  });

  it('executions_total status policy covers every ExecutionRunStatus value', () => {
    const policy = METRIC_LABEL_POLICY.kici_orch_executions_total;
    expect(policy?.status?.values).toEqual([...ExecutionRunStatus.options]);
    // Regression guard for the original bug: pending/cancelling/held must be allowed.
    for (const s of ['pending', 'cancelling', 'held']) {
      expect(policy?.status?.values).toContain(s);
    }
  });

  it('scaler resource gauges cap the free-form name and enum-constrain scalerType', () => {
    for (const name of [
      'kici_orch_scaler_cpus_used',
      'kici_orch_scaler_memory_bytes_used',
    ] as const) {
      const policy = METRIC_LABEL_POLICY[name];
      // scaler carries the operator-chosen name → capped, NOT a closed enum.
      expect(policy?.scaler?.maxUniqueValues).toBe(50);
      expect(policy?.scaler?.values).toBeUndefined();
      // scalerType is the backend-type rollup dimension → closed enum.
      expect(policy?.scalerType?.values).toEqual([...ORCH_SCALER_VALUES]);
      expect(policy?.machinePool?.maxUniqueValues).toBe(50);
    }
  });

  it('declares event_name as a capped label and result/reason as closed enums for the event family', () => {
    expect(METRIC_LABEL_POLICY.kici_orch_event_attempts).toEqual({
      event_name: { maxUniqueValues: 50 },
      result: { values: ['success', 'dlq'] },
    });
    expect(METRIC_LABEL_POLICY.kici_orch_event_dlq_total?.reason).toEqual({
      values: ['exhausted_retries'],
    });
  });
});

function findMetricLabels(name: MetricName): readonly string[] {
  for (const [key, candidate] of Object.entries(MetricNames)) {
    if (candidate === name) {
      return MetricLabels[key as keyof typeof MetricLabels];
    }
  }
  return [];
}

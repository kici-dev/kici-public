import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * Knob ↔ limit-gauge parity drift guard.
 *
 * Every effective cap the admission controller enforces is exported as a
 * config-sourced limit gauge so the dashboard shows current-vs-limit and the
 * ratio alerts track the config. This test keeps the shown limits in track with
 * the code: it asserts every `KICI_INGEST_*` env knob is classified as either a
 * cap (with a matching emitted `*_limit`-style gauge) or an explicit non-limit
 * timing tunable — so a new/renamed knob without a decision fails CI.
 */

const configSrc = readFileSync(fileURLToPath(new URL('../config.ts', import.meta.url)), 'utf8');
const promSrc = readFileSync(fileURLToPath(new URL('./prometheus.ts', import.meta.url)), 'utf8');

/** Cap knob → the config-sourced limit gauge that must plot it. */
const LIMIT_KNOB_TO_GAUGE: Record<string, string> = {
  KICI_INGEST_MAX_CONCURRENCY: 'kici_orch_ingest_max_concurrency',
  KICI_INGEST_MAX_QUEUE_DEPTH: 'kici_orch_ingest_max_queue_depth',
  KICI_INGEST_ORG_MAX_CONCURRENCY: 'kici_orch_ingest_org_max_concurrency',
  KICI_INGEST_LOOP_LAG_SHED_MS: 'kici_orch_ingest_loop_lag_shed_ms',
  KICI_INGEST_LOOP_LAG_RESUME_MS: 'kici_orch_ingest_loop_lag_resume_ms',
  // Overflow buffer row cap: current depth (kici_orch_ingest_overflow_buffered)
  // is plotted against this limit, same current-vs-limit shape as the queue cap.
  KICI_INGEST_OVERFLOW_MAX: 'kici_orch_ingest_overflow_max',
};

/** Timing / policy tunables that are deliberately NOT surfaced as current-vs-limit gauges. */
const NON_LIMIT_INGEST_KNOBS = new Set<string>([
  'KICI_INGEST_CODEL_TARGET_MS',
  'KICI_INGEST_CODEL_INTERVAL_MS',
  'KICI_INGEST_QUEUE_MAX_WAIT_MS',
  'KICI_INGEST_LOOP_LAG_SAMPLE_MS',
  // Overflow buffer knobs with no current-vs-limit overlay: a boolean policy
  // toggle, the replayer pass interval, the per-pass replay batch size, and the
  // per-row replay attempt ceiling.
  'KICI_INGEST_OVERFLOW_ENABLED',
  'KICI_INGEST_OVERFLOW_REPLAY_INTERVAL_MS',
  'KICI_INGEST_OVERFLOW_REPLAY_BATCH',
  'KICI_INGEST_OVERFLOW_MAX_ATTEMPTS',
]);

describe('ingest knob ↔ limit-gauge parity', () => {
  const knobsInConfig = Array.from(new Set(configSrc.match(/KICI_INGEST_[A-Z_]+/g) ?? []));

  it('config declares at least the known ingest knobs', () => {
    expect(knobsInConfig.length).toBeGreaterThanOrEqual(
      Object.keys(LIMIT_KNOB_TO_GAUGE).length + NON_LIMIT_INGEST_KNOBS.size,
    );
  });

  it('every KICI_INGEST_* knob is classified as a cap or an explicit non-limit tunable', () => {
    for (const knob of knobsInConfig) {
      const isCap = knob in LIMIT_KNOB_TO_GAUGE;
      const isNonLimit = NON_LIMIT_INGEST_KNOBS.has(knob);
      expect(
        isCap !== isNonLimit,
        `${knob} must be classified in exactly one of LIMIT_KNOB_TO_GAUGE / NON_LIMIT_INGEST_KNOBS — add a limit gauge or classify it`,
      ).toBe(true);
    }
  });

  it('every cap knob has its limit gauge emitted in prometheus.ts', () => {
    for (const [knob, gauge] of Object.entries(LIMIT_KNOB_TO_GAUGE)) {
      expect(knobsInConfig, `cap knob ${knob} missing from config`).toContain(knob);
      expect(promSrc, `limit gauge ${gauge} for ${knob} not emitted`).toContain(`'${gauge}'`);
    }
  });
});

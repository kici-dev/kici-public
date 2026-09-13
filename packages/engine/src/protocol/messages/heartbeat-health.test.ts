import { describe, it, expect } from 'vitest';
import {
  HEARTBEAT_FRESH_MS,
  HEARTBEAT_DEGRADED_MS,
  HEARTBEAT_STALE_THRESHOLD_SECONDS,
  HEARTBEAT_UNHEALTHY_MARK_MS,
  HEARTBEAT_CLOSE_MS,
  connectionHealthStatusSchema,
} from './heartbeat-health.js';

describe('heartbeat-health policy', () => {
  it('pins the three freshness boundaries', () => {
    expect(HEARTBEAT_FRESH_MS).toBe(60_000);
    expect(HEARTBEAT_DEGRADED_MS).toBe(300_000);
    expect(HEARTBEAT_STALE_THRESHOLD_SECONDS).toBe(360);
  });

  it('pins the two teardown boundaries', () => {
    // ws/heartbeat.ts applies these verbatim, so changing either moves live
    // teardown timing and requires re-running the reconnect and WS relay E2E
    // categories.
    expect(HEARTBEAT_UNHEALTHY_MARK_MS).toBe(90_000);
    expect(HEARTBEAT_CLOSE_MS).toBe(180_000);
  });

  it('orders the two heartbeat policies consistently', () => {
    // Rendering is tighter than teardown: a badge may say "unhealthy" before
    // the owning instance marks the row, and that gap is intentional.
    expect(HEARTBEAT_FRESH_MS).toBeLessThan(HEARTBEAT_UNHEALTHY_MARK_MS);
    // A socket cannot be closed before it has been marked.
    expect(HEARTBEAT_UNHEALTHY_MARK_MS).toBeLessThan(HEARTBEAT_CLOSE_MS);
    // The sweeper's levels sit past the close so a clean close's own row delete
    // at 180s always beats the sweep: 'stale' at 300s and 'orphaned' past 360s
    // describe rows that delete never ran for.
    expect(HEARTBEAT_CLOSE_MS).toBeLessThan(HEARTBEAT_DEGRADED_MS);
    expect(HEARTBEAT_DEGRADED_MS).toBeLessThan(HEARTBEAT_STALE_THRESHOLD_SECONDS * 1000);
  });

  it('keeps the orphan-sweeper cutoff at twice the close threshold', () => {
    // orphan-sweeper.ts documents the sweeper cutoff as 2x the teardown close;
    // pin it now that both constants live in this module.
    expect(HEARTBEAT_STALE_THRESHOLD_SECONDS * 1000).toBe(2 * HEARTBEAT_CLOSE_MS);
  });

  it('exposes exactly the four connection health statuses', () => {
    expect(connectionHealthStatusSchema.options).toEqual([
      'connected',
      'unhealthy',
      'stale',
      'orphaned',
    ]);
  });

  it('rejects a status outside the enum', () => {
    expect(connectionHealthStatusSchema.safeParse('degraded').success).toBe(false);
  });
});

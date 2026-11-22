import { describe, it, expect } from 'vitest';
import { checkScalerProvisioning, SCALER_FAILURE_WINDOW_MS } from './scaler.js';
import { DIAGNOSE_TABLE_MESSAGE_WIDTH } from '../../cli/commands/diagnose.js';
import type { DiagnosticDeps } from '../types.js';
import type { ProvisionBackoffStatus, ScalerManager } from '../../scaler/manager.js';
import type { BackendFailureSummary } from '../../scaler/failure-tracker.js';

function makeDeps(
  backends: Array<{ name: string; type: string; retiring?: boolean; activeCount?: number }>,
  failures: Record<string, BackendFailureSummary>,
  backoffs: Record<string, ProvisionBackoffStatus> = {},
): DiagnosticDeps {
  const fake = {
    getStatus: () => ({ backends }),
    recentSpawnFailures: () => new Map(Object.entries(failures)),
    provisionBackoffStatus: () => new Map(Object.entries(backoffs)),
  } as unknown as ScalerManager;
  return { config: {}, scalerManager: fake };
}

describe('checkScalerProvisioning', () => {
  it('returns a single PASS row when no scaler manager is present', async () => {
    const results = await checkScalerProvisioning({ config: {} } as DiagnosticDeps);
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ name: 'scaler', status: 'pass' });
    expect(results[0].message).toMatch(/no scaler backends/i);
  });

  it('returns a single PASS row when no backends are configured', async () => {
    const results = await checkScalerProvisioning(makeDeps([], {}));
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ name: 'scaler', status: 'pass' });
  });

  it('emits an OK row per configured backend with no recent failures', async () => {
    const results = await checkScalerProvisioning(
      makeDeps(
        [
          { name: 'container-1', type: 'container' },
          { name: 'bare-1', type: 'bare-metal' },
        ],
        {},
      ),
    );
    expect(results.map((r) => r.name)).toEqual(['scaler:container-1', 'scaler:bare-1']);
    expect(results.every((r) => r.status === 'pass')).toBe(true);
    expect(results[0].message).toMatch(/0 spawn failures in last 5m/);
  });

  it('WARNs when a backend has only warm-pool (unbound) failures', async () => {
    const results = await checkScalerProvisioning(
      makeDeps([{ name: 'container-1', type: 'container' }], {
        'container-1': {
          backendType: 'container',
          boundCount: 0,
          unboundCount: 2,
          lastError: 'no such image',
          lastAtMs: 5_000,
        },
      }),
    );
    expect(results[0]).toMatchObject({ name: 'scaler:container-1', status: 'warn' });
    expect(results[0].message).toMatch(
      /2 spawn failures in last 5m \(0 bound, 2 warm-pool; last: no such image\)/,
    );
  });

  it('FAILs when a backend has any job-bound failure', async () => {
    const results = await checkScalerProvisioning(
      makeDeps([{ name: 'container-1', type: 'container' }], {
        'container-1': {
          backendType: 'container',
          boundCount: 1,
          unboundCount: 1,
          lastError: 'spawn ENOENT',
          lastAtMs: 7_000,
        },
      }),
    );
    expect(results[0]).toMatchObject({ name: 'scaler:container-1', status: 'fail' });
    expect(results[0].message).toMatch(
      /2 spawn failures in last 5m \(1 bound, 1 warm-pool; last: spawn ENOENT\)/,
    );
    expect(results[0].details).toMatchObject({
      windowMs: SCALER_FAILURE_WINDOW_MS,
      backendType: 'container',
      boundCount: 1,
      unboundCount: 1,
      lastError: 'spawn ENOENT',
    });
  });
});

describe('checkScalerProvisioning backoff', () => {
  it('warns for a scaler still backing off after its failures left the window', async () => {
    const results = await checkScalerProvisioning(
      makeDeps(
        [{ name: 'container-1', type: 'container' }],
        {},
        { 'container-1': { consecutiveFailures: 7, deferUntilMs: Date.now() + 600_000 } },
      ),
    );

    // fails-when: the row reads only the 5-minute window, so a 15-minute deferral looks healthy
    expect(results[0]).toMatchObject({ name: 'scaler:container-1', status: 'warn' });
    const visible = results[0].message.substring(0, DIAGNOSE_TABLE_MESSAGE_WIDTH);
    expect(visible).toContain('failing (7 in a row');
    expect(results[0].details).toMatchObject({ consecutiveFailures: 7 });
  });

  it('keeps a job-bound failure a FAIL while backing off', async () => {
    const results = await checkScalerProvisioning(
      makeDeps(
        [{ name: 'container-1', type: 'container' }],
        {
          'container-1': {
            backendType: 'container',
            boundCount: 2,
            unboundCount: 0,
            lastError: 'no such image',
            lastAtMs: Date.now(),
          },
        },
        { 'container-1': { consecutiveFailures: 2, deferUntilMs: Date.now() + 30_000 } },
      ),
    );

    expect(results[0].status).toBe('fail');
    expect(results[0].message).toMatch(/^failing \(2 in a row, next try in 30s\) — 2 spawn/);
  });

  it('drops the marker once nothing is deferred', async () => {
    const now = Date.now();
    const results = await checkScalerProvisioning(
      makeDeps(
        [
          { name: 'blip', type: 'container' },
          { name: 'expired', type: 'container' },
        ],
        {},
        {
          // One transient failure: retried at once, so its deferral ends where it starts.
          blip: { consecutiveFailures: 1, deferUntilMs: now },
          // A deferral that ran out, with no spawn since (its job was cancelled).
          expired: { consecutiveFailures: 3, deferUntilMs: now - 60_000 },
        },
      ),
    );

    // fails-when: the row marks every scaler with a failure count, and reads
    // `failing (1 in a row, next try in 0s)` for hours after a single blip
    for (const row of results) {
      expect(row.status).toBe('pass');
      expect(row.message).toBe('0 spawn failures in last 5m');
      expect(row.details).not.toHaveProperty('consecutiveFailures');
    }
  });

  it('passes a scaler with no failures and no backoff', async () => {
    const results = await checkScalerProvisioning(
      makeDeps([{ name: 'container-1', type: 'container' }], {}, {}),
    );
    // breaks-if-wrong: a healthy scaler must still read PASS with no marker
    expect(results[0].status).toBe('pass');
    expect(results[0].message).toBe('0 spawn failures in last 5m');
  });
});

describe('checkScalerProvisioning retirement', () => {
  it('reports a retiring backend and its remaining agent count', async () => {
    const results = await checkScalerProvisioning(
      makeDeps([{ name: 'gone', type: 'container', retiring: true, activeCount: 2 }], {}),
    );

    expect(results).toHaveLength(1);
    expect(results[0].message).toContain('retiring');
    expect(results[0].message).toContain('2 agent(s) left');
    expect(results[0].details).toMatchObject({ retiring: true, activeCount: 2 });
  });

  it('keeps the retirement marker inside the diagnose table width', async () => {
    const results = await checkScalerProvisioning(
      makeDeps([{ name: 'gone', type: 'container', retiring: true, activeCount: 2 }], {
        gone: {
          backendType: 'container',
          boundCount: 3,
          unboundCount: 9,
          lastError: 'x'.repeat(200),
          lastAtMs: Date.now(),
        },
      }),
    );

    // `formatDiagnoseTable` (cli/commands/diagnose.ts) cuts each message at 42 characters, so
    // a marker after the failure text is never rendered: assert on the visible slice.
    const visible = results[0].message.substring(0, DIAGNOSE_TABLE_MESSAGE_WIDTH);
    expect(visible).toContain('retiring');
    expect(visible).toContain('2 agent(s) left');
  });

  it('says nothing about retirement for a configured backend', async () => {
    const results = await checkScalerProvisioning(
      makeDeps([{ name: 'live', type: 'container', retiring: false, activeCount: 1 }], {}),
    );

    expect(results[0].message).not.toContain('retiring');
    expect(results[0].details).toMatchObject({ retiring: false });
  });
});

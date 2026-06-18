import { describe, it, expect } from 'vitest';
import { checkScalerProvisioning, SCALER_FAILURE_WINDOW_MS } from './scaler.js';
import type { DiagnosticDeps } from '../types.js';
import type { ScalerManager } from '../../scaler/manager.js';
import type { BackendFailureSummary } from '../../scaler/failure-tracker.js';

function makeDeps(
  backends: Array<{ name: string; type: string }>,
  failures: Record<string, BackendFailureSummary>,
): DiagnosticDeps {
  const fake = {
    getStatus: () => ({ backends }),
    recentSpawnFailures: () => new Map(Object.entries(failures)),
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

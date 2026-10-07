import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  ScalerReloadOutcome,
  ScalerVmStatus,
  ScalerVmStopOutcome,
  ScalerVmTracker,
  type ScalerLiveVm,
} from '@kici-dev/engine';
import {
  formatAge,
  isOrchestratorHealthy,
  runScalerOrphans,
  runScalerReload,
  type ScalerOrphansOptions,
} from './scaler.js';

describe('isOrchestratorHealthy', () => {
  afterEach(() => vi.restoreAllMocks());

  it('returns true when /health responds 200', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('{"status":"ok"}', { status: 200 })),
    );
    expect(await isOrchestratorHealthy(4000, '/')).toBe(true);
  });

  it('returns false when /health is unreachable', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('ECONNREFUSED');
      }),
    );
    expect(await isOrchestratorHealthy(4000, '/')).toBe(false);
  });

  it('returns false on a non-200 status', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('down', { status: 503 })),
    );
    expect(await isOrchestratorHealthy(4000, '/')).toBe(false);
  });

  it('honours a non-root basePath when building the probe URL', async () => {
    const fetchMock = vi.fn(async () => new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    await isOrchestratorHealthy(4000, '/kici/');
    expect(fetchMock).toHaveBeenCalledWith('http://127.0.0.1:4000/kici/health', expect.any(Object));
  });
});

describe('kici-admin scaler orphans (runScalerOrphans)', () => {
  const NODE = { instanceId: 'worker-1', role: 'worker' as const, firecrackerScalers: ['fc'] };

  function vm(vmId: string, status: ScalerVmStatus, reason = 'why'): ScalerLiveVm {
    return {
      vmId,
      scaler: 'fc',
      pid: 4242,
      startedAt: new Date(0).toISOString(),
      ageSeconds: 3_720,
      chrootDir: `/srv/jailer/firecracker/${vmId}/root`,
      status,
      trackedBy: status === ScalerVmStatus.enum.tracked ? [ScalerVmTracker.enum.registered] : [],
      reason,
    };
  }

  const VMS = [
    vm('vm-orphan', ScalerVmStatus.enum.orphaned),
    vm('vm-unverified', ScalerVmStatus.enum.unverified),
    vm('vm-tracked', ScalerVmStatus.enum.tracked, 'tracked: registered'),
  ];

  function fakeClient(
    outcome: (vmId: string) => ScalerVmStopOutcome = () => ScalerVmStopOutcome.enum.stopped,
    vms: ScalerLiveVm[] = VMS,
  ) {
    return {
      listScalerOrphans: vi.fn(async () => ({ node: NODE, vms })),
      stopScalerOrphans: vi.fn(async (body: { vmIds: string[] }) => ({
        node: NODE,
        results: body.vmIds.map((vmId) => ({ vmId, outcome: outcome(vmId), detail: 'd' })),
      })),
    };
  }

  function io(confirmed = true) {
    const out: string[] = [];
    const err: string[] = [];
    return {
      out,
      err,
      io: {
        confirm: vi.fn(async () => confirmed),
        out: (line: string) => out.push(line),
        err: (line: string) => err.push(line),
      },
    };
  }

  const opts = (over: Partial<ScalerOrphansOptions> = {}): ScalerOrphansOptions => ({
    all: false,
    stop: false,
    vm: [],
    yes: false,
    dryRun: false,
    timeout: '30',
    json: false,
    ...over,
  });

  it('lists orphaned and unverified VMs and hides tracked ones', async () => {
    const t = io();
    expect(await runScalerOrphans(fakeClient(), opts(), t.io)).toBe(0);
    const text = t.out.join('\n');
    expect(text).toContain('vm-orphan');
    expect(text).toContain('vm-unverified');
    expect(text).not.toContain('vm-tracked');
    expect(text).toContain('1h2m');
  });

  it('names the disconnected coordinator peers in the listing and before a stop', async () => {
    const client = fakeClient(undefined, [VMS[1]!]);
    client.listScalerOrphans.mockResolvedValue({
      node: { ...NODE, disconnectedCoordinators: ['coord-b'] },
      vms: [VMS[1]!],
    } as never);
    const t = io();
    await runScalerOrphans(client, opts(), t.io);
    expect(t.out.join('\n')).toContain('Coordinator peer(s) not connected: coord-b');
    const s = io();
    expect(await runScalerOrphans(client, opts({ stop: true, yes: true }), s.io)).toBe(0);
    expect(s.err.join('\n')).toContain('coord-b');
    expect(client.stopScalerOrphans).not.toHaveBeenCalled();
  });

  it('--all shows tracked VMs too', async () => {
    const t = io();
    await runScalerOrphans(fakeClient(), opts({ all: true }), t.io);
    expect(t.out.join('\n')).toContain('vm-tracked');
  });

  it('--json prints the route body verbatim', async () => {
    const t = io();
    await runScalerOrphans(fakeClient(), opts({ json: true }), t.io);
    expect(JSON.parse(t.out.join('\n'))).toEqual({ node: NODE, vms: VMS });
  });

  it('--stop with nothing orphaned never posts', async () => {
    const client = fakeClient(undefined, [VMS[1]!, VMS[2]!]);
    const t = io();
    expect(await runScalerOrphans(client, opts({ stop: true, yes: true }), t.io)).toBe(0);
    expect(client.stopScalerOrphans).not.toHaveBeenCalled();
    expect(t.err.join('\n')).toContain('No orphaned VMs on worker-1.');
  });

  it('--stop declined at the prompt posts nothing and exits 0', async () => {
    const client = fakeClient();
    const t = io(false);
    expect(await runScalerOrphans(client, opts({ stop: true }), t.io)).toBe(0);
    expect(t.io.confirm).toHaveBeenCalledWith('Stop these VMs on worker-1? [y/N] ');
    expect(client.stopScalerOrphans).not.toHaveBeenCalled();
  });

  // fails-when: the CLI sends an id it did not show as orphaned
  it('--stop --yes sends exactly the orphaned ids, never an unverified one', async () => {
    const client = fakeClient();
    const t = io();
    expect(await runScalerOrphans(client, opts({ stop: true, yes: true }), t.io)).toBe(0);
    expect(client.stopScalerOrphans).toHaveBeenCalledWith({
      vmIds: ['vm-orphan'],
      timeoutMs: 30_000,
    });
    expect(t.io.confirm).not.toHaveBeenCalled();
  });

  it('--vm narrows the stop and reports a tracked id without sending it', async () => {
    const client = fakeClient(undefined, [...VMS, vm('vm-orphan-2', ScalerVmStatus.enum.orphaned)]);
    const t = io();
    // fails-when: a --vm id that was never sent exits 0, so a script reads it as reclaimed
    expect(
      await runScalerOrphans(
        client,
        opts({ stop: true, yes: true, vm: ['vm-orphan-2', 'vm-tracked'] }),
        t.io,
      ),
    ).toBe(1);
    expect(client.stopScalerOrphans).toHaveBeenCalledWith({
      vmIds: ['vm-orphan-2'],
      timeoutMs: 30_000,
    });
    expect(t.err.join('\n')).toContain('vm-tracked: not an orphan (tracked: registered)');
  });

  it('--vm naming only a VM that is not an orphan posts nothing and exits 1', async () => {
    const client = fakeClient();
    const t = io();
    expect(
      await runScalerOrphans(client, opts({ stop: true, yes: true, vm: ['vm-unverified'] }), t.io),
    ).toBe(1);
    expect(client.stopScalerOrphans).not.toHaveBeenCalled();
  });

  // breaks-if-wrong: --vm naming only orphans that all stop still exits 0
  it('--vm naming an orphan that stops exits 0', async () => {
    const client = fakeClient();
    expect(
      await runScalerOrphans(client, opts({ stop: true, yes: true, vm: ['vm-orphan'] }), io().io),
    ).toBe(0);
  });

  it('--dry-run posts nothing', async () => {
    const client = fakeClient();
    const t = io();
    expect(await runScalerOrphans(client, opts({ stop: true, dryRun: true }), t.io)).toBe(0);
    expect(client.stopScalerOrphans).not.toHaveBeenCalled();
    expect(t.io.confirm).not.toHaveBeenCalled();
  });

  // fails-when: a VM the node did not stop exits 0, so a script reads it as reclaimed
  it('exits 1 when a result is not stopped, printing its detail', async () => {
    const client = fakeClient(() => ScalerVmStopOutcome.enum.tracked);
    const t = io();
    expect(await runScalerOrphans(client, opts({ stop: true, yes: true }), t.io)).toBe(1);
    expect(t.out.join('\n')).toContain('vm-orphan: tracked — d');
  });

  it('passes --target and --timeout to both calls', async () => {
    const client = fakeClient();
    await runScalerOrphans(
      client,
      opts({ stop: true, yes: true, target: 'worker-1', timeout: '45' }),
      io().io,
    );
    expect(client.listScalerOrphans).toHaveBeenCalledWith({
      target: 'worker-1',
      timeoutMs: 45_000,
    });
    expect(client.stopScalerOrphans).toHaveBeenCalledWith({
      target: 'worker-1',
      vmIds: ['vm-orphan'],
      timeoutMs: 45_000,
    });
  });

  it('--stop --json keeps stdout to one JSON document', async () => {
    const t = io();
    await runScalerOrphans(fakeClient(), opts({ stop: true, yes: true, json: true }), t.io);
    expect(t.out).toHaveLength(1);
    expect(JSON.parse(t.out[0]!)).toMatchObject({
      outcome: 'applied',
      results: [{ vmId: 'vm-orphan', outcome: ScalerVmStopOutcome.enum.stopped }],
    });
  });

  it('refuses stop-only flags without --stop and an out-of-range timeout', async () => {
    await expect(runScalerOrphans(fakeClient(), opts({ yes: true }), io().io)).rejects.toThrow(
      '--stop only',
    );
    await expect(runScalerOrphans(fakeClient(), opts({ timeout: '0' }), io().io)).rejects.toThrow(
      '--timeout',
    );
  });
});

describe('formatAge', () => {
  it('renders seconds, minutes, hours and days', () => {
    expect(formatAge(45)).toBe('45s');
    expect(formatAge(723)).toBe('12m3s');
    expect(formatAge(3_720)).toBe('1h2m');
    expect(formatAge(3 * 86_400 + 4 * 3_600)).toBe('3d4h');
  });
});

describe('kici-admin scaler reload (runScalerReload)', () => {
  const plan = {
    added: ['arm'],
    updated: ['linux'],
    unchanged: ['gpu', 'mac'],
    retired: [],
    resurrected: [],
    global: [],
  };

  function run(
    results: unknown[],
    opts: Partial<{ single: boolean; timeout: string; json: boolean }> = {},
  ) {
    const lines: string[] = [];
    const client = {
      scalerReload: vi.fn(async () => ({ scope: 'cluster' as const, results: results as never })),
    };
    const code = runScalerReload(
      client,
      { single: false, timeout: '60', json: false, ...opts },
      (line) => lines.push(line),
    );
    return { client, lines, code };
  }

  // breaks-if-wrong: an all-applied cluster exits 0
  it('prints one block per instance and exits 0 when every instance applied', async () => {
    const { client, lines, code } = run([
      {
        instanceId: 'coord-a',
        role: 'coordinator',
        outcome: ScalerReloadOutcome.enum.applied,
        plan,
      },
      {
        instanceId: 'worker-b',
        role: 'worker',
        outcome: ScalerReloadOutcome.enum['not-configured'],
      },
    ]);
    expect(await code).toBe(0);
    expect(client.scalerReload).toHaveBeenCalledWith({ timeoutMs: 60_000 });
    expect(lines.join('\n')).toBe(
      [
        'coord-a (coordinator): applied',
        '  added: arm',
        '  updated: linux',
        '  unchanged: 2',
        'worker-b (worker): not-configured',
      ].join('\n'),
    );
  });

  // fails-when: a partial failure exits 0
  it('exits 1 and prints the errors when an instance refused or was not reached', async () => {
    const { lines, code } = run([
      {
        instanceId: 'coord-a',
        role: 'coordinator',
        outcome: ScalerReloadOutcome.enum.rejected,
        errors: ['overlap'],
      },
      {
        instanceId: 'coord-b',
        role: 'coordinator',
        outcome: ScalerReloadOutcome.enum.unreachable,
        detail: 'no answer',
      },
    ]);
    expect(await code).toBe(1);
    expect(lines.join('\n')).toContain('  error: overlap');
    expect(lines.join('\n')).toContain('  no answer');
  });

  it('--json prints the response body, --single and --timeout reach the request', async () => {
    const results = [
      {
        instanceId: 'coord-a',
        role: 'coordinator',
        outcome: ScalerReloadOutcome.enum.applied,
        plan,
      },
    ];
    const { client, lines, code } = run(results, { single: true, timeout: '5', json: true });
    expect(await code).toBe(0);
    expect(client.scalerReload).toHaveBeenCalledWith({ single: true, timeoutMs: 5_000 });
    expect(JSON.parse(lines.join('\n'))).toEqual({ scope: 'cluster', results });
  });

  it('refuses a bad --timeout before any request', async () => {
    const { client, code } = run([], { timeout: 'soon' });
    await expect(code).rejects.toThrow('--timeout must be a whole number of seconds');
    expect(client.scalerReload).not.toHaveBeenCalled();
  });
});

import { describe, it, expect, vi } from 'vitest';
import { scalerAgentLabels } from '@kici-dev/engine';
import { EventScalerBackend } from './event-backend.js';
import { ClaimStore } from './claim-store.js';
import { makeFakeScalerStateStore } from '../__test-helpers__/fake-scaler-state-store.js';
import type { ScalerEntry } from './types.js';
import {
  incScalerScaleUpEmitted,
  incScalerScaleDownEmitted,
  incScalerExternalProvisionTimeout,
  setScalerExternalProvisioningActive,
} from '../metrics/prometheus.js';

vi.mock('../metrics/prometheus.js', () => ({
  incScalerScaleUpEmitted: vi.fn(),
  incScalerScaleDownEmitted: vi.fn(),
  incScalerExternalProvisionTimeout: vi.fn(),
  setScalerExternalProvisioningActive: vi.fn(),
}));

function makeEntry(overrides: Partial<ScalerEntry> = {}): ScalerEntry {
  return {
    name: 'hetzner',
    type: 'event',
    maxAgents: 5,
    maxConcurrentSpawns: 8,
    provisioningTargets: ['org/infra'],
    agentTokenTtlSeconds: 600,
    labelSets: [{ labels: ['cloud=hetzner'] }],
    ...overrides,
  } as ScalerEntry;
}

function makeBackend(overrides: { emitUp?: any; emitDown?: any; entry?: ScalerEntry } = {}) {
  const emitUp = overrides.emitUp ?? vi.fn().mockResolvedValue('evt-up');
  const emitDown = overrides.emitDown ?? vi.fn().mockResolvedValue('evt-down');
  const now = () => 1000;
  const claimStore = new ClaimStore({
    createEphemeral: vi.fn().mockResolvedValue('kat_x'),
    stateStore: makeFakeScalerStateStore(now),
    scalerName: 'hetzner',
    now,
    ttlDefaultSec: 300,
  });
  const entry = overrides.entry ?? makeEntry();
  const backend = new EventScalerBackend({
    entry,
    emitter: { emitScalerScaleUp: emitUp, emitScalerScaleDown: emitDown },
    claimStore,
    requestId: () => 'r1',
  });
  return { backend, emitUp, emitDown, claimStore, entry };
}

describe('EventScalerBackend', () => {
  it('has type event and does not spawn on the local host', () => {
    const { backend } = makeBackend();
    expect(backend.type).toBe('event');
    expect(backend.spawnsOnLocalHost).toBe(false);
  });

  it('spawn emits scale-up with a claim code and tracks the agent', async () => {
    const { backend, emitUp, entry } = makeBackend();
    const ma = await backend.spawn(['cloud=hetzner'], 'a1', 'wss://h/ws');

    expect(emitUp).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: 'a1',
        claimCode: expect.any(String),
        scalerName: 'hetzner',
      }),
      entry.provisioningTargets,
    );
    expect(ma.id).toBe('a1');
    expect(ma.state).toBe('spawning');
    expect(backend.getActiveCount()).toBe(1);
  });

  it('binds the ephemeral token AND the scale-up labels to the full scaler label set', async () => {
    // Regression: the self-bootstrapping agent presents the scaler-assigned
    // kici:agent:/kici:scaler:/kici:role: labels at registration. Binding the
    // token to only the raw labelSet made the orchestrator reject the register
    // with "labels exceed token-bound scope", so the bound job never ran. The
    // token (and the KICI_LABELS the provisioning workflow derives from the
    // event) must carry the full scalerAgentLabels() set — matching the
    // container / bare-metal / firecracker backends.
    const createEphemeral = vi.fn().mockResolvedValue('kat_full');
    const now = () => 1000;
    const claimStore = new ClaimStore({
      createEphemeral,
      stateStore: makeFakeScalerStateStore(now),
      scalerName: 'hetzner',
      now,
      ttlDefaultSec: 300,
    });
    const emitUp = vi.fn().mockResolvedValue('evt-up');
    const entry = makeEntry();
    const backend = new EventScalerBackend({
      entry,
      emitter: { emitScalerScaleUp: emitUp, emitScalerScaleDown: vi.fn() },
      claimStore,
      requestId: () => 'r1',
    });

    const expected = scalerAgentLabels(['cloud=hetzner'], 'event', entry.name, entry.roles);
    // Sanity: the full set is a strict superset of the raw labelSet and carries
    // the scaler-assigned labels the agent will self-report.
    expect(expected).toEqual(expect.arrayContaining(['cloud=hetzner', 'kici:scaler:hetzner']));
    expect(expected.some((l) => l.startsWith('kici:role:'))).toBe(true);

    await backend.spawn(['cloud=hetzner'], 'a1', 'wss://h/ws');

    // The emitted scale-up carries the full label set (drives the agent's KICI_LABELS).
    expect(emitUp.mock.calls[0][0].labels).toEqual(expected);

    // Redeeming the claim mints the token bound to exactly that full set.
    const code = emitUp.mock.calls[0][0].claimCode as string;
    const claimed = await claimStore.claim(code);
    expect(createEphemeral).toHaveBeenCalledWith('a1', expected, 600 * 1000);
    expect(claimed.labels).toEqual(expected);
  });

  it('threads the bound job id into the scale-up payload', async () => {
    const { backend, emitUp } = makeBackend();
    await backend.spawn(['cloud=hetzner'], 'a1', 'wss://h/ws', undefined, undefined, {
      boundJobId: 'job-9',
      runId: 'run-1',
    });
    expect(emitUp.mock.calls[0][0]).toMatchObject({ jobId: 'job-9' });
  });

  it('destroy emits scale-down with the reason and stops tracking', async () => {
    const { backend, emitDown, entry } = makeBackend();
    await backend.spawn(['cloud=hetzner'], 'a1', 'wss://h/ws');
    await backend.destroy('a1', { reason: 'job-complete' });

    expect(emitDown).toHaveBeenCalledWith(
      expect.objectContaining({ agentId: 'a1', reason: 'job-complete' }),
      entry.provisioningTargets,
    );
    expect(backend.getActiveCount()).toBe(0);
  });

  it('defaults the scale-down reason to shutdown', async () => {
    const { backend, emitDown } = makeBackend();
    await backend.spawn(['cloud=hetzner'], 'a1', 'wss://h/ws');
    await backend.destroy('a1');
    expect(emitDown.mock.calls[0][0]).toMatchObject({ reason: 'shutdown' });
  });

  it('destroy is idempotent — a repeat is a no-op with no duplicate scale-down', async () => {
    const { backend, emitDown } = makeBackend();
    await backend.spawn(['cloud=hetzner'], 'a1', 'wss://h/ws');
    await backend.destroy('a1', { reason: 'idle' });
    await backend.destroy('a1', { reason: 'idle' });
    expect(emitDown).toHaveBeenCalledOnce();
  });

  it('destroy no-ops for an id this backend never tracked', async () => {
    // The complement of the adopt test below: destroy's unknown-id guard is
    // exactly what makes seeding necessary, so pin it before relying on it.
    const { backend, emitDown } = makeBackend();
    await backend.destroy('never-spawned-here', { reason: 'shutdown' });
    expect(emitDown).not.toHaveBeenCalled();
  });

  it('adopt seeds an agent another instance spawned, so destroy tears it down', async () => {
    const { backend, emitDown, entry } = makeBackend();

    backend.adopt('a1', ['cloud=hetzner']);
    expect(backend.getActiveCount()).toBe(1);

    await backend.destroy('a1', { reason: 'shutdown' });
    expect(emitDown).toHaveBeenCalledWith(
      expect.objectContaining({ agentId: 'a1', reason: 'shutdown' }),
      entry.provisioningTargets,
    );
    expect(backend.getActiveCount()).toBe(0);
  });

  it('adopt leaves an already-tracked agent alone', async () => {
    const { backend } = makeBackend();
    await backend.spawn(['cloud=hetzner'], 'a1', 'wss://h/ws');
    vi.mocked(setScalerExternalProvisioningActive).mockClear();

    backend.adopt('a1', ['cloud=other']);

    // Returned at the already-tracked guard: no re-seed, so the gauge is not
    // republished. (The entry's own fields are private and `getActiveCount()`
    // reads 1 either way, so the gauge write is the whole observable effect.)
    expect(backend.getActiveCount()).toBe(1);
    expect(setScalerExternalProvisioningActive).not.toHaveBeenCalled();
  });

  it('destroy invalidates the pending claim so its code can no longer be redeemed', async () => {
    const { backend, claimStore, emitDown } = makeBackend();
    const spy = vi.spyOn(claimStore, 'invalidate');
    await backend.spawn(['cloud=hetzner'], 'a1', 'wss://h/ws');
    await backend.destroy('a1', { reason: 'idle' });
    expect(spy).toHaveBeenCalledWith('a1');
    // The invalidate runs after the scale-down, so a failing DB delete cannot
    // suppress the teardown the customer workflow acts on.
    expect(spy.mock.invocationCallOrder[0]).toBeGreaterThan(emitDown.mock.invocationCallOrder[0]);
  });

  it('emits scale-down even when invalidating the pending claim fails', async () => {
    // The invalidate is a DB delete. Were it able to reject out of destroy, the
    // agent would already be untracked, so the teardown event would never fire
    // and a retried destroy would return at the idempotency guard — leaving the
    // provisioned cloud instance running forever.
    const { backend, claimStore, emitDown } = makeBackend();
    vi.spyOn(claimStore, 'invalidate').mockRejectedValue(new Error('db down'));
    await backend.spawn(['cloud=hetzner'], 'a1', 'wss://h/ws');

    await expect(backend.destroy('a1', { reason: 'idle' })).resolves.toBeUndefined();

    expect(emitDown).toHaveBeenCalledOnce();
    expect(emitDown.mock.calls[0][0]).toMatchObject({ agentId: 'a1', reason: 'idle' });
    expect(backend.getActiveCount()).toBe(0);
  });

  it('rejects a spawn whose signal is already aborted', async () => {
    const { backend } = makeBackend();
    const ac = new AbortController();
    ac.abort();
    await expect(
      backend.spawn(
        ['cloud=hetzner'],
        'a1',
        'wss://h/ws',
        undefined,
        undefined,
        undefined,
        ac.signal,
      ),
    ).rejects.toThrow(/aborted/);
    expect(backend.getActiveCount()).toBe(0);
  });

  it('records event-scaler metrics on spawn and destroy', async () => {
    vi.mocked(incScalerScaleUpEmitted).mockClear();
    vi.mocked(incScalerScaleDownEmitted).mockClear();
    vi.mocked(incScalerExternalProvisionTimeout).mockClear();
    vi.mocked(setScalerExternalProvisioningActive).mockClear();

    const { backend } = makeBackend();
    await backend.spawn(['cloud=hetzner'], 'a1', 'wss://h/ws');
    expect(incScalerScaleUpEmitted).toHaveBeenCalledWith('hetzner');
    expect(setScalerExternalProvisioningActive).toHaveBeenLastCalledWith('hetzner', 1);

    await backend.destroy('a1', { reason: 'spawn-timeout' });
    expect(incScalerScaleDownEmitted).toHaveBeenCalledWith('hetzner', 'spawn-timeout');
    expect(incScalerExternalProvisionTimeout).toHaveBeenCalledWith('hetzner');
    expect(setScalerExternalProvisioningActive).toHaveBeenLastCalledWith('hetzner', 0);
  });

  it('does not count a non-timeout teardown as a provision timeout', async () => {
    vi.mocked(incScalerExternalProvisionTimeout).mockClear();
    const { backend } = makeBackend();
    await backend.spawn(['cloud=hetzner'], 'a1', 'wss://h/ws');
    await backend.destroy('a1', { reason: 'job-complete' });
    expect(incScalerExternalProvisionTimeout).not.toHaveBeenCalled();
  });

  it('forget() drops the entry without emitting a teardown', async () => {
    vi.mocked(setScalerExternalProvisioningActive).mockClear();
    const { backend, emitDown } = makeBackend();
    await backend.spawn(['cloud=hetzner'], 'a1', 'wss://h/ws');
    expect(backend.getActiveCount()).toBe(1);

    backend.forget('a1');

    expect(backend.getActiveCount()).toBe(0);
    expect(emitDown).not.toHaveBeenCalled();
    expect(setScalerExternalProvisioningActive).toHaveBeenLastCalledWith('hetzner', 0);
  });

  it('forget() of an unknown agent leaves the gauge alone', async () => {
    const { backend } = makeBackend();
    await backend.spawn(['cloud=hetzner'], 'a1', 'wss://h/ws');
    vi.mocked(setScalerExternalProvisioningActive).mockClear();

    backend.forget('not-tracked');

    expect(backend.getActiveCount()).toBe(1);
    expect(setScalerExternalProvisioningActive).not.toHaveBeenCalled();
  });

  it('shutdownAll() emits no teardown for the provisions it still tracks', async () => {
    const { backend, emitDown } = makeBackend();
    await backend.spawn(['cloud=hetzner'], 'a1', 'wss://h/ws');
    await backend.spawn(['cloud=hetzner'], 'a2', 'wss://h/ws');

    await backend.shutdownAll();

    // The map carries provisions a peer may already have adopted — the spawner
    // is never told — so a routine restart must not tear them down.
    expect(emitDown).not.toHaveBeenCalled();
    // Left tracked, so a WS close during the rest of shutdown still emits.
    expect(backend.getActiveCount()).toBe(2);
  });

  it('destroy() delivers to the caller-supplied targets over live config', async () => {
    const { backend, emitDown } = makeBackend();
    await backend.spawn(['cloud=hetzner'], 'a1', 'wss://h/ws');

    await backend.destroy('a1', { reason: 'shutdown', targets: ['org/recorded'] });

    expect(emitDown).toHaveBeenCalledWith(expect.objectContaining({ agentId: 'a1' }), [
      'org/recorded',
    ]);
  });

  it('destroy() falls back to live config when the caller names no targets', async () => {
    const { backend, emitDown } = makeBackend();
    await backend.spawn(['cloud=hetzner'], 'a1', 'wss://h/ws');

    await backend.destroy('a1', { reason: 'shutdown', targets: [] });

    expect(emitDown).toHaveBeenCalledWith(expect.objectContaining({ agentId: 'a1' }), [
      'org/infra',
    ]);
  });

  it('claim() delegates to the claim store', async () => {
    const { backend, claimStore } = makeBackend();
    const spy = vi.spyOn(claimStore, 'claim');
    await backend.spawn(['cloud=hetzner'], 'a1', 'wss://h/ws');
    const code = await claimStore.register({
      agentId: 'a1',
      labels: ['cloud=hetzner'],
      mandatoryLabels: [],
      agentTokenTtlSeconds: 600,
      orchestratorUrl: 'wss://h/ws',
    });
    await backend.claim(code);
    expect(spy).toHaveBeenCalledWith(code);
  });

  it('reload() applies new label sets and a new maxAgents', () => {
    const { backend } = makeBackend();
    expect(backend.maxAgents).toBe(5);

    const result = backend.reload([{ labels: ['cloud=aws'] }], { maxAgents: 9 });

    expect(result.valid).toBe(true);
    expect(backend.labelSets).toEqual([{ labels: ['cloud=aws'] }]);
    expect(backend.maxAgents).toBe(9);
  });

  it('reload() keeps the current maxAgents when the opts argument is omitted', () => {
    const { backend } = makeBackend();
    backend.reload([{ labels: ['cloud=aws'] }]);
    expect(backend.maxAgents).toBe(5);
  });
});

describe('EventScalerBackend reload applies the new entry', () => {
  it('retargets the provisioning workflow a reload moved', async () => {
    const { backend, emitUp } = makeBackend();
    await backend.spawn(['cloud=hetzner'], 'a-1', 'ws://orch/ws');
    expect(emitUp.mock.calls[0][1]).toEqual(['org/infra']);

    backend.reload([{ labels: ['cloud=hetzner'] }], {
      entry: makeEntry({ provisioningTargets: ['org/new-infra'] }),
    });
    await backend.spawn(['cloud=hetzner'], 'a-2', 'ws://orch/ws');

    expect(emitUp.mock.calls[1][1]).toEqual(['org/new-infra']);
  });

  it('applies new roles and mandatoryLabels to the next spawn', async () => {
    const { backend, emitUp } = makeBackend();

    backend.reload([{ labels: ['cloud=hetzner'] }], {
      entry: makeEntry({ roles: ['builder'], mandatoryLabels: ['gpu'] }),
    });
    await backend.spawn(['cloud=hetzner'], 'a-1', 'ws://orch/ws');

    const payload = emitUp.mock.calls[0][0] as {
      labels: string[];
      mandatoryLabels: string[];
    };
    expect(payload.mandatoryLabels).toEqual(['gpu']);
    expect(payload.labels).toContain('kici:role:builder');
  });

  it('exposes the entry it is serving, and swaps it on reload', () => {
    const { backend } = makeBackend();
    expect(backend.currentEntry.provisioningTargets).toEqual(['org/infra']);

    backend.reload([{ labels: ['cloud=hetzner'] }], {
      entry: makeEntry({ provisioningTargets: ['org/new-infra'] }),
    });

    expect(backend.currentEntry.provisioningTargets).toEqual(['org/new-infra']);
  });

  it('keeps the current entry when the opts argument omits one', async () => {
    const { backend, emitUp } = makeBackend();
    backend.reload([{ labels: ['cloud=hetzner'] }], { maxAgents: 9 });
    await backend.spawn(['cloud=hetzner'], 'a-1', 'ws://orch/ws');

    expect(emitUp.mock.calls[0][1]).toEqual(['org/infra']);
    expect(backend.maxAgents).toBe(9);
  });
});

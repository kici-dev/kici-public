import { describe, it, expect, vi } from 'vitest';
import { agentVersionConverge, type AgentVersionDrift } from './agent-version-converge.js';
import type { StepContext } from '../context.js';

interface Status {
  targetVersion: string;
  stagedVersion: string | null;
  available: boolean;
}

/** Build a StepContext whose bootstrap surface returns a fixed status + records restage calls. */
function makeCtx(status: Status, restaged = { restaged: true }) {
  const restageAgent = vi.fn(async () => restaged);
  const agentVersionStatus = vi.fn(async () => status);
  const ctx = {
    log: { info: () => {} },
    kici: { bootstrap: { agentVersionStatus, restageAgent } },
  } as unknown as StepContext;
  return { ctx, restageAgent, agentVersionStatus };
}

const TARGET = 'box-7';

describe('agentVersionConverge', () => {
  it('reports drift when the staged version differs and the target is available', async () => {
    const { ctx } = makeCtx({ targetVersion: '2.0.0', stagedVersion: '1.0.0', available: true });
    const s = agentVersionConverge(TARGET);
    const drift = (await s.check!(ctx)) as AgentVersionDrift;
    expect(drift).toEqual({ blocked: false, from: '1.0.0', to: '2.0.0' });
  });

  it('reports a BLOCKED drift when the target payload is unavailable', async () => {
    const { ctx } = makeCtx({ targetVersion: '3.0.0', stagedVersion: '2.0.0', available: false });
    const drift = (await agentVersionConverge(TARGET).check!(ctx)) as AgentVersionDrift;
    expect(drift.blocked).toBe(true);
    expect(drift).toMatchObject({ from: '2.0.0', to: '3.0.0' });
  });

  it('is in sync (null drift) when staged equals target', async () => {
    const { ctx } = makeCtx({ targetVersion: '2.0.0', stagedVersion: '2.0.0', available: true });
    expect(await agentVersionConverge(TARGET).check!(ctx)).toBeNull();
  });

  it('apply re-stages via the ops agent for an available drift', async () => {
    const { ctx, restageAgent } = makeCtx({
      targetVersion: '2.0.0',
      stagedVersion: '1.0.0',
      available: true,
    });
    const s = agentVersionConverge(TARGET);
    const drift = (await s.check!(ctx)) as AgentVersionDrift;
    const res = await s.run!(ctx, drift);
    expect(restageAgent).toHaveBeenCalledWith(TARGET);
    expect(res).toEqual({ restaged: true });
  });

  it('apply THROWS on a blocked drift — never re-stages a missing version (no skew)', async () => {
    const { ctx, restageAgent } = makeCtx({
      targetVersion: '3.0.0',
      stagedVersion: '2.0.0',
      available: false,
    });
    const s = agentVersionConverge(TARGET);
    const drift = (await s.check!(ctx)) as AgentVersionDrift;
    await expect(s.run!(ctx, drift)).rejects.toThrow(/refusing to converge|skew/i);
    expect(restageAgent).not.toHaveBeenCalled();
  });

  it('whenInSync yields restaged:false', async () => {
    const { ctx } = makeCtx({ targetVersion: '2.0.0', stagedVersion: '2.0.0', available: true });
    expect(await agentVersionConverge(TARGET).whenInSync!(ctx)).toEqual({ restaged: false });
  });

  it('honors a custom step name', () => {
    expect(agentVersionConverge(TARGET, { name: 'roll' }).name).toBe('roll');
  });
});

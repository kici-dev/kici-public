import { describe, it, expect } from 'vitest';
import {
  platformToOsArchLabels,
  platformToTaints,
  scalerAgentLabels,
  type ScalerPlatform,
} from '@kici-dev/engine';
import type { WsLike } from '@kici-dev/engine';
import { AgentRegistry } from '../agent/registry.js';

/**
 * The whole path a platform taint travels, asserted end to end through the
 * registry rather than on an intermediate.
 *
 * A taint gates a job AND has to reach the agent it gates. When it reached only
 * the gate, `AgentRegistry.findAvailable` failed its SUBSET check — no agent
 * carried the plain token — so a tainted pool spawned agents the dispatcher
 * could never find: the job re-queued and spawned again forever. The warm pool
 * hit the same defect through its GATE check and reported `ready: 0`.
 *
 * The unit layer is the only place this is coverable: our E2E hosts are x86
 * linux and derive no taint at all.
 */
describe('platform taint reachability', () => {
  const platform: ScalerPlatform = { os: 'linux', arch: 'arm64' };
  const taints = platformToTaints(platform);

  /**
   * The labels an agent this pool spawned actually registers with: the set the
   * scaler injects (and binds the ephemeral token to), plus the os/arch facts
   * the agent self-reports on top.
   */
  function registeredLabels(labelSet: string[]): string[] {
    const injected = scalerAgentLabels(labelSet, 'bare-metal', 'gpu-pool', undefined, taints);
    return [...new Set([...injected, ...platformToOsArchLabels(platform)])];
  }

  /** A registry holding one agent from that pool, gated by the pool's taints. */
  function registryWithPoolAgent(labelSet: string[]): AgentRegistry {
    const registry = new AgentRegistry();
    registry.register(
      'agent-1',
      {} as WsLike,
      registeredLabels(labelSet),
      'linux',
      'arm64',
      '1',
      1,
      {
        // `ScalerManager.labelSetMandatoryLabels` — no configured gate here, so
        // the taints are the whole gate.
        mandatoryLabels: [...taints],
      },
    );
    return registry;
  }

  it('injects the taint into the labels the agent registers with', () => {
    expect(taints).toEqual(['arm64']);
    expect(registeredLabels(['linux'])).toContain('arm64');
  });

  it('lets a job asking for the platform find the pool it was routed to', () => {
    const registry = registryWithPoolAgent(['linux']);

    // The job that could never match before: `findAvailable` intersects the
    // required labels, and no agent carried the plain `arm64` token.
    expect(registry.findAvailable(['linux', ...taints])).toHaveLength(1);
  });

  it('lets the warm pool count the agent it just spawned', () => {
    // `ScalerManager.warmPoolQueryLabels` — the declared set widened by the
    // taints, which is what satisfies the agent's own mandatory-labels gate.
    const queryLabels = ['linux', 'gpu', ...taints];
    const registry = registryWithPoolAgent(['linux', 'gpu']);

    expect(registry.findAvailable(queryLabels)).toHaveLength(1);
  });

  it('still refuses a job that does not ask for the platform', () => {
    const registry = registryWithPoolAgent(['linux']);

    // The gate is the point of a taint: an unqualified linux job must not land
    // on an arm64 pool just because the agent now carries the token.
    expect(registry.findAvailable(['linux'])).toHaveLength(0);
  });

  it('is not vacuous: dropping the taint from the injected set breaks the match', () => {
    // Reproduces the defect exactly — the same agent WITHOUT the taint in its
    // labels, still gated by it. Asserted here rather than by reverting the
    // source, which a concurrent build would ship.
    const withoutTaint = scalerAgentLabels(['linux'], 'bare-metal', 'gpu-pool', undefined);
    const registry = new AgentRegistry();
    registry.register(
      'agent-1',
      {} as WsLike,
      [...withoutTaint, ...platformToOsArchLabels(platform)],
      'linux',
      'arm64',
      '1',
      1,
      { mandatoryLabels: [...taints] },
    );

    expect(registry.findAvailable(['linux', ...taints])).toHaveLength(0);
  });
});

import { describe, it, expect } from 'vitest';
import { stringifyActor, type ActorPrincipal } from '@kici-dev/engine';
import { adminActorSub, triggererSubjectFor } from './triggerer-subject.js';

/**
 * The self-approval gate in `applyDecision` refuses an approve when
 * `actorSub === triggererSub`. Every case here pins one side of that
 * comparison against the other: the persisted `triggered_by` string on the left
 * (built with the real `stringifyActor`, never a hand-written literal, so a
 * change to the persisted format fails here rather than silently), and the live
 * subject the approving surface would produce on the right.
 */
describe('triggererSubjectFor', () => {
  /** How the dashboard handler renders a live actor (`actorSub`). */
  function dashboardActorSub(actor: ActorPrincipal): string {
    if (actor.type === 'user' || actor.type === 'platform_operator') return actor.sub;
    if (actor.type === 'api_key') return actor.ownerSub;
    if (actor.type === 'service_account') return adminActorSub(actor.id);
    return `system:${actor.component}`;
  }

  it('matches the dashboard subject for a plain user', () => {
    const actor: ActorPrincipal = { type: 'user', sub: 'kc-sub-1' };
    expect(triggererSubjectFor(stringifyActor(actor))).toBe(dashboardActorSub(actor));
  });

  it('matches the dashboard subject for a user acting through an agent', () => {
    // The regression: `stringifyActor` appends ` via agent:<label>`, so a bare
    // split-on-first-colon yielded `kc-sub-2 via agent:builder` and the gate
    // could never fire for an agent-mediated trigger.
    const actor: ActorPrincipal = {
      type: 'user',
      sub: 'kc-sub-2',
      agent: { label: 'builder' },
    };
    const stored = stringifyActor(actor);
    expect(stored).toContain(' via agent:');
    expect(triggererSubjectFor(stored)).toBe(dashboardActorSub(actor));
  });

  it('matches the dashboard subject for a platform operator', () => {
    const actor: ActorPrincipal = { type: 'platform_operator', sub: 'kc-op-1', reason: 'support' };
    expect(triggererSubjectFor(stringifyActor(actor))).toBe(dashboardActorSub(actor));
  });

  it('matches the dashboard subject for a service account', () => {
    const actor: ActorPrincipal = { type: 'service_account', id: 'ops-token' };
    const resolved = triggererSubjectFor(stringifyActor(actor));
    expect(resolved).toBe(dashboardActorSub(actor));
    // The namespace is the point: a bare id would collide with a Keycloak sub.
    expect(resolved).toBe('service:ops-token');
    expect(resolved).not.toBe('ops-token');
  });

  it('matches the dashboard subject for a system actor', () => {
    const actor: ActorPrincipal = { type: 'system', component: 'dispatcher' };
    const resolved = triggererSubjectFor(stringifyActor(actor));
    expect(resolved).toBe(dashboardActorSub(actor));
    expect(resolved).toBe('system:dispatcher');
  });

  it('keeps the admin route and the dashboard on one service namespace', () => {
    expect(adminActorSub('ops-token')).toBe(
      triggererSubjectFor(stringifyActor({ type: 'service_account', id: 'ops-token' })),
    );
  });

  it('returns the bare key id for an api_key, the documented residual', () => {
    // No string transform bridges a persisted `keyId` to the live `ownerSub`
    // both surfaces render, so this one case is deliberately still unmatched.
    const actor: ActorPrincipal = { type: 'api_key', keyId: 'key-1', ownerSub: 'kc-owner-1' };
    expect(triggererSubjectFor(stringifyActor(actor))).toBe('key-1');
    expect(dashboardActorSub(actor)).toBe('kc-owner-1');
  });

  it('strips the agent suffix from an api_key trigger too', () => {
    const stored = stringifyActor({
      type: 'api_key',
      keyId: 'key-2',
      ownerSub: 'kc-owner-2',
      agent: { label: 'runner' },
    });
    expect(triggererSubjectFor(stored)).toBe('key-2');
  });

  it('passes through an empty or unprefixed value unchanged', () => {
    expect(triggererSubjectFor(null)).toBeUndefined();
    expect(triggererSubjectFor(undefined)).toBeUndefined();
    expect(triggererSubjectFor('')).toBeUndefined();
    expect(triggererSubjectFor('no-colon')).toBe('no-colon');
  });
});

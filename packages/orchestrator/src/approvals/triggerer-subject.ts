/**
 * Map a persisted `execution_runs.triggered_by` onto the subject vocabulary
 * `applyDecision` compares an approver against.
 *
 * `applyDecision` refuses an approve when `actorSub === triggererSub`, so both
 * must be in the SAME vocabulary, or the self-approval gate compares strings
 * that can never be equal and admits the actor who triggered the run.
 *
 * By default they differ: `triggered_by` is `stringifyActor`'s output, while the
 * approving surfaces render a live actor differently per type. Each diverging
 * shape is handled below.
 */
import { ACTOR_AGENT_SUFFIX, ActorType } from '@kici-dev/engine';

/**
 * The `service:` namespace both approving surfaces use for a non-human
 * principal: `kici-admin`'s token identity (its only subject), and the
 * dashboard's rendering of a `service_account` actor.
 */
export const SERVICE_SUBJECT_PREFIX = 'service:';

/** Render an admin-token user id in the shared `service:` namespace. */
export function adminActorSub(tokenUserId: string): string {
  return `${SERVICE_SUBJECT_PREFIX}${tokenUserId}`;
}

/**
 * Resolve the subject of whoever triggered a run, in the approver vocabulary.
 *
 * | `triggered_by` | Returns | Why |
 * |---|---|---|
 * | `user:<sub>` | `<sub>` | what a `{user}` clause and both surfaces' own subject use |
 * | `platform_operator:<sub>` | `<sub>` | same Keycloak subject as a `user` |
 * | `service_account:<id>` | `service:<id>` | the namespace {@link adminActorSub} and the dashboard both produce |
 * | `system:<component>` | `system:<component>` | the dashboard renders a system actor with its prefix intact |
 * | `api_key:<keyId>` | `<keyId>` | see the residual below |
 * | anything else | unchanged | no other actor type reaches these surfaces |
 *
 * The agent suffix is stripped first. `stringifyActor` renders a `user` or
 * `api_key` who acted through an agent as `user:<sub> via agent:<label>`, and
 * splitting on the first colon alone gives `<sub> via agent:<label>`, which
 * matches no live subject and leaves the gate inert for every agent-mediated
 * trigger — the common `user` case.
 *
 * **Residual: `api_key`.** A key's persisted identifier is its `keyId`, while
 * both surfaces render a live `api_key` actor as its owner's Keycloak subject
 * (`ownerSub`). No string transform bridges them; closing it needs a keyId →
 * ownerSub lookup, a store this pure function lacks. So an owner approving a
 * hold on a run their own key triggered is still admitted. Returning the bare
 * keyId is at least honest about what was stored.
 */
export function triggererSubjectFor(triggeredBy: string | null | undefined): string | undefined {
  if (!triggeredBy) return undefined;
  const suffixAt = triggeredBy.indexOf(ACTOR_AGENT_SUFFIX);
  const withoutAgent = suffixAt < 0 ? triggeredBy : triggeredBy.slice(0, suffixAt);
  const idx = withoutAgent.indexOf(':');
  if (idx < 0) return withoutAgent;
  const kind = withoutAgent.slice(0, idx);
  const id = withoutAgent.slice(idx + 1);
  switch (kind) {
    case ActorType.enum.service_account:
      return adminActorSub(id);
    case ActorType.enum.system:
      // The dashboard's own subject for a system actor keeps the prefix, so the
      // stored form is already in the approver vocabulary.
      return withoutAgent;
    default:
      return id;
  }
}

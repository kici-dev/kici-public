/**
 * Map a persisted `execution_runs.triggered_by` onto the subject vocabulary
 * `applyDecision` compares an approver against.
 *
 * `applyDecision` refuses an approve when `actorSub === triggererSub`, so the
 * two have to be written in the SAME vocabulary or the self-approval gate is
 * inert — it compares two strings that can never be equal and lets every
 * approve through, including one cast by the actor who triggered the run.
 *
 * They are not the same vocabulary by default. `triggered_by` is
 * `stringifyActor`'s output; the approving surfaces render a live actor
 * differently per type. Three shapes diverge and each is handled below.
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
 * `api_key` who acted through an agent as `user:<sub> via agent:<label>`, and a
 * reader splitting on the first colon gets `<sub> via agent:<label>` — which
 * matches no live subject, so the gate was inert for every agent-mediated
 * trigger. That is the `user` case, i.e. the common one.
 *
 * **Residual: `api_key`.** A key's persisted identifier is its `keyId`, while
 * both surfaces render a live `api_key` actor as its owner's Keycloak subject
 * (`ownerSub`). Those are different identifiers for the same principal and no
 * string transform bridges them — closing it needs a keyId → ownerSub lookup,
 * which is a store this pure function does not have. So an owner approving a
 * hold on a run their own key triggered is still admitted. Recorded rather than
 * papered over: returning the bare keyId is at least honest about what was
 * stored.
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

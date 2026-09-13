/**
 * The one predicate for "this run's contributor is not trusted".
 *
 * It lives beside `trust-resolver.ts` and `reduced-privilege-note.ts` — the
 * modules that decide and render the posture it reads — rather than inside any
 * one consumer, because three unrelated subsystems now withhold credentials on
 * it: the install-secrets resolver, the job secret gate, and container-registry
 * auth. A copy per consumer is how two of them would end up disagreeing about
 * what an absent tier means.
 */

import type { TrustTier } from '@kici-dev/engine';

/**
 * True when the resolved trust tier is anything other than 'trusted'.
 *
 * `undefined` is the LENIENT direction here: an unresolved tier leaves
 * credentials in place, while `deriveCacheRefScope` maps the same `undefined`
 * to the isolated cache scope, which is what `resolveWorkflowDockerfileBuilds`
 * then denies unless the org opted in. `evaluateTrustGate` reads it leniently
 * too; `deriveCacheRefScope`, `selectLockFileSource`, and the trust-policy
 * gate's `isNonTrusted` all read the same `undefined` strictly.
 *
 * Several dispatch paths reach it with no tier, and the set is open — a
 * provider bundle carrying a fork model does not keep a run out of it. Among
 * them: an internally-triggered run whose inheritance lookup degrades, a
 * pull-request event from a provider with no fork model, a cross-source
 * dispatch, and a `kici run` remote test run. Treat "no tier" as its own case
 * rather than as a proxy for any one of them. Documented for operators in
 * `docs/user/events.md` under the trust-tier rules.
 */
export function isUntrustedTier(tier: TrustTier | undefined): boolean {
  if (tier === undefined) return false;
  return tier !== 'trusted';
}

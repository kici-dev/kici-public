/**
 * The direct-ingress `ProcessingDeps` assembly.
 *
 * A forgotten wiring field reads as `undefined`, downstream guards degrade
 * rather than throw, and the feature is silently inert. This file guards the
 * two fields that matter most: `trustPolicyStore` (without it the fork switch
 * applies `FAIL_CLOSED_POLICY` and drops every fork PR) and `heldRunStore`
 * (without it no hold can be raised on an independent orchestrator's only
 * pipeline).
 *
 * The second block runs against a real database: the assembled bag, handed to
 * the pipeline's `evaluateSecurityPolicy`, answers `ignore` for an org with no
 * stored row and `hold` for one whose operator chose `hold`. A stub store would
 * prove only that the field is read, not that `kici-admin trust-policy set`
 * reaches the verdict.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { type Kysely, sql } from 'kysely';
import { describeWithTestDb } from '@kici-dev/test-support/test-db';
import { ForkPolicy, OrchestratorMode } from '@kici-dev/engine';
import type { Database } from '../db/types.js';
import { createMigrationProvider } from '../db/migration-provider.js';
import { TrustDirectoryStore } from '../security/trust-directory-store.js';
import { TrustPolicyStore } from '../security/trust-policy-store.js';
import { EffectivePolicySource } from '../security/trust-policy-gate.js';
import { SecurityHoldReason } from '../contexts/held-runs.js';
import {
  createDirectIngressProcessingDeps,
  type DirectIngressDepsSource,
} from './direct-ingress-deps.js';
import { evaluateSecurityPolicy } from './process-webhook.js';
import type { ProviderBundle } from '../provider-registry.js';

const NOOP_HOOKS = { onSourceLocationsExtracted: vi.fn() };

/**
 * The smallest source the factory type-checks against. Unset fields stay
 * undefined, as a deployment without that subsystem hands them over.
 */
function sourceWith(partial: Partial<DirectIngressDepsSource> = {}): DirectIngressDepsSource {
  return {
    db: {} as never,
    config: { mode: OrchestratorMode.enum.independent },
    dedup: {} as never,
    providerRegistry: { name: 'registry-a' } as never,
    lockFileCache: {} as never,
    dispatcher: {} as never,
    ...partial,
  } as DirectIngressDepsSource;
}

describe('createDirectIngressProcessingDeps', () => {
  it('hands the pipeline a trust-policy store, so the fork switch can read a stored row', () => {
    // Without this the switch resolves `stored = null` on every delivery and
    // applies the fail-closed `ignore` — the org's own choice unreachable.
    const { build } = createDirectIngressProcessingDeps(sourceWith(), NOOP_HOOKS);
    expect(build().trustPolicyStore).toBeInstanceOf(TrustPolicyStore);
  });

  it('hands the pipeline a trust-directory store, so `/kici approve` can resolve a commenter', () => {
    const { build } = createDirectIngressProcessingDeps(sourceWith(), NOOP_HOOKS);
    expect(build().trustDirectoryStore).toBeInstanceOf(TrustDirectoryStore);
  });

  it('supplies no in-memory directory, so the store is what gets read', () => {
    // `resolveApprovalDirectory` prefers an in-memory directory, so either field
    // here would skip the store and an independent orchestrator would refuse
    // every commenter.
    const bag = createDirectIngressProcessingDeps(sourceWith(), NOOP_HOOKS).build();
    expect(bag.identityLinks).toBeUndefined();
    expect(bag.orgMemberPermissions).toBeUndefined();
  });

  it.each(OrchestratorMode.options)('reports the configured mode verbatim (%s)', (mode) => {
    const { build } = createDirectIngressProcessingDeps(
      sourceWith({ config: { mode } }),
      NOOP_HOOKS,
    );
    expect(build().orchestratorMode).toBe(mode);
  });

  it('passes the held-run store through when the mode hook supplied one', () => {
    const heldRunStore = { marker: 'held' } as never;
    const { build } = createDirectIngressProcessingDeps(sourceWith({ heldRunStore }), NOOP_HOOKS);
    expect(build().heldRunStore).toBe(heldRunStore);
  });

  it('leaves the held-run store undefined when the mode hook supplied none', () => {
    // The deliberate degraded shape: every hold site guards on this field.
    expect(
      createDirectIngressProcessingDeps(sourceWith(), NOOP_HOOKS).build().heldRunStore,
    ).toBeUndefined();
  });

  it('reassembles per call, so a swapped provider registry is picked up', () => {
    // A source reload replaces the registry; a captured bag would keep the old one.
    const src = sourceWith();
    const { build } = createDirectIngressProcessingDeps(src, NOOP_HOOKS);
    expect((build().providerRegistry as unknown as { name: string }).name).toBe('registry-a');
    src.providerRegistry = { name: 'registry-b' } as never;
    expect((build().providerRegistry as unknown as { name: string }).name).toBe('registry-b');
  });

  it('constructs each store once for the process, not once per delivery', () => {
    const { build } = createDirectIngressProcessingDeps(sourceWith(), NOOP_HOOKS);
    const first = build();
    const second = build();
    expect(second.trustPolicyStore).toBe(first.trustPolicyStore);
    expect(second.trustDirectoryStore).toBe(first.trustDirectoryStore);
  });

  it('marks every delivery on this bag as direct, never relayed', () => {
    expect(createDirectIngressProcessingDeps(sourceWith(), NOOP_HOOKS).build().eventLogSource).toBe(
      'direct',
    );
  });
});

// ---------------------------------------------------------------------------
// End-to-end: the assembled bag against a real stored policy.
// ---------------------------------------------------------------------------

/** The one field `evaluateSecurityPolicy` reads off the bundle. */
const FORK_MODEL_BUNDLE = { hasForkModel: true } as unknown as ProviderBundle;

describeWithTestDb<Database>(
  'the fork switch, driven through the assembled direct-ingress bag',
  {
    prefix: 'kici_directingress_test',
    provider: createMigrationProvider(),
    timeoutMs: 120_000,
  },
  (getDb) => {
    let db: Kysely<Database>;
    beforeAll(() => {
      ({ db } = getDb());
    });

    beforeEach(async () => {
      await sql`DELETE FROM org_trust_policy`.execute(db);
    });

    const evaluate = (mode: OrchestratorMode) =>
      evaluateSecurityPolicy({
        deps: createDirectIngressProcessingDeps(
          sourceWith({ db: db as never, config: { mode } }),
          NOOP_HOOKS,
        ).build(),
        bundle: FORK_MODEL_BUNDLE,
        isPREvent: true,
        resolvedOrgId: 'org-1',
        mode,
        trustResolution: undefined,
        isForkPR: true,
      });

    it('drops a fork PR for an org that has chosen nothing', async () => {
      // Fail closed: no row means no operator opted in, so forks must not run.
      expect(await evaluate(OrchestratorMode.enum.independent)).toEqual({
        action: 'ignore',
        forkSwitch: {
          policy: ForkPolicy.enum.ignore,
          source: EffectivePolicySource.enum.unconfigured,
          platformManaged: false,
        },
      });
    });

    it('HOLDS a fork PR once the operator stored `hold`', async () => {
      // Without the store in this bag, `kici-admin trust-policy set
      // --fork-policy hold` has no effect on the direct-ingress pipeline.
      await new TrustPolicyStore(db).upsertLocal('org-1', { forkPolicy: ForkPolicy.enum.hold });
      const outcome = await evaluate(OrchestratorMode.enum.independent);
      expect(outcome).toMatchObject({
        action: 'hold',
        reason: SecurityHoldReason.enum.fork_pr,
      });
    });

    it('RUNS a fork PR once the operator stored `allow`', async () => {
      await new TrustPolicyStore(db).upsertLocal('org-1', { forkPolicy: ForkPolicy.enum.allow });
      expect(await evaluate(OrchestratorMode.enum.independent)).toEqual({
        action: 'pass',
        forkSwitch: {
          policy: ForkPolicy.enum.allow,
          source: EffectivePolicySource.enum.stored,
          platformManaged: false,
        },
      });
    });

    it('reads the same stored row in every mode, so no mode is quietly exempt', async () => {
      // The direct GitHub ingress also serves hybrid and observed mode.
      await new TrustPolicyStore(db).upsertLocal('org-1', { forkPolicy: ForkPolicy.enum.hold });
      for (const mode of OrchestratorMode.options) {
        expect(await evaluate(mode)).toMatchObject({ action: 'hold' });
      }
    });
  },
);

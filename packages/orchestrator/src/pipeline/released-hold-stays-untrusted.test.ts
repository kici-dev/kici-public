/**
 * Approving a security hold means "let it run", never "make it trusted".
 *
 * Wiring the approval subsystem into independent mode is what makes a fork PR
 * reach a hold there at all, so the property that hold's RELEASE must preserve
 * is worth asserting on its own: the resumed dispatch replays with the tier the
 * held dispatch resolved, and every reduced-privilege decision is derived from
 * that tier rather than from anything the approval carries.
 *
 * The three degradations, and the value each reads:
 *
 * | Degradation | Derived from |
 * | --- | --- |
 * | base-branch lock file | `ctx.lockFileSource`, resolved before the hold |
 * | stripped install / registry secrets | `ctx.trustResolution.tier` |
 * | isolated cache write scope | `ctx.trustResolution.tier` |
 *
 * None of them reads the hold row, the approver, or the orchestrator's mode —
 * so the test drives the real round trip (`toSerializableInputs` → the JSON the
 * `pending_workflow_contexts` row stores → `rebuildWorkflowDispatchContext`) and
 * then feeds the rebuilt values to the real deciders.
 */
import { describe, expect, it } from 'vitest';
import { CacheRefScope } from '@kici-dev/engine';
import type { TrustResolution } from '../security/trust-resolver.js';
import { deriveCacheRefScope, type WorkflowDispatchContext } from './dispatch-matched-workflow.js';
import { toSerializableInputs } from './pending-workflow-context.js';
import { rebuildWorkflowDispatchContext } from './resume-workflow.js';
import { resolveInstallSecrets } from './install-secrets-resolver.js';
import type { ProcessingDeps } from './processor.js';

const UNTRUSTED: TrustResolution = {
  tier: 'unknown',
  contributorUsername: 'mallory',
} as unknown as TrustResolution;

const TRUSTED: TrustResolution = {
  tier: 'trusted',
  contributorUsername: 'alice',
} as unknown as TrustResolution;

/** A held fork-PR dispatch, in the shape `holdRunForSecurityPolicy` stores. */
function heldContext(trustResolution: TrustResolution): WorkflowDispatchContext {
  return {
    runId: 'run-1',
    resolvedOrgId: 'org-1',
    repoIdentifier: 'acme/app',
    ref: 'deadbeef',
    // Resolved by the held dispatch: an untrusted ref reads the BASE branch's
    // lock file, never the contributor's own.
    lockFileSource: 'base',
    trustResolution,
    info: { routingKey: 'rk-1' },
    workflow: { name: 'ci' },
    event: {},
    credentials: {},
    // Stripped by `toSerializableInputs` — present here so the strip is real.
    deps: { marker: 'live-deps' },
    bundle: { marker: 'live-bundle' },
  } as unknown as WorkflowDispatchContext;
}

/** The live deps the resume re-attaches, with a registry that resolves `rk-1`. */
const LIVE_DEPS = {
  providerRegistry: {
    getByRoutingKey: (key: string) => (key === 'rk-1' ? { hasForkModel: true } : undefined),
  },
} as unknown as ProcessingDeps;

/** Replay the persisted hold context exactly as `resumeWorkflow` does. */
function replay(trustResolution: TrustResolution): WorkflowDispatchContext {
  const stored = toSerializableInputs(heldContext(trustResolution));
  // The `pending_workflow_contexts` row is `JSON.stringify`d, so anything that
  // does not survive a JSON round trip is gone by the time a release reads it.
  const fromRow = JSON.parse(JSON.stringify(stored));
  const rebuilt = rebuildWorkflowDispatchContext(fromRow, LIVE_DEPS);
  if (!rebuilt) throw new Error('the replay could not rebuild its dispatch context');
  return rebuilt;
}

describe('a released security hold replays with the tier its held dispatch resolved', () => {
  it('carries the untrusted tier through the stored row', () => {
    expect(replay(UNTRUSTED).trustResolution?.tier).toBe('unknown');
  });

  it('keeps the base-branch lock file', () => {
    // The contributor's own head lock file never becomes readable because a
    // reviewer approved the run.
    expect(replay(UNTRUSTED).lockFileSource).toBe('base');
  });

  it('keeps the isolated cache write scope', () => {
    expect(deriveCacheRefScope(replay(UNTRUSTED).trustResolution)).toBe(
      CacheRefScope.enum.isolated,
    );
  });

  it('would give a trusted run the shared scope, so the assertion above discriminates', () => {
    // Positive control: without it, a `deriveCacheRefScope` that returned
    // `isolated` unconditionally would pass the test above.
    expect(deriveCacheRefScope(replay(TRUSTED).trustResolution)).toBe(CacheRefScope.enum.shared);
  });

  it('still strips the install and registry secrets', async () => {
    const resolved = await resolveInstallSecrets({
      registries: [{ url: 'https://npm.example.com', tokenSecret: 'prod:NPM_TOKEN' }] as never,
      installEnv: ['prod:BUILD_TOKEN'],
      allowHttpNpmRegistries: false,
      resolvedOrgId: 'org-1',
      trustResolution: replay(UNTRUSTED).trustResolution,
      contextStore: undefined,
      // Deliberately absent: reaching a resolver at all would already mean the
      // strip did not happen, since the strip returns before any lookup.
      secretResolver: undefined,
      protectionContext: {} as never,
      // The resume path's own flag. The strip runs first regardless, which is
      // exactly the claim — a released hold does not skip it.
      skipProtectionGate: true,
    });
    expect(resolved).toMatchObject({
      decision: 'pass',
      contributorStripped: true,
      npmRegistries: undefined,
      installEnvSecrets: undefined,
    });
  });

  it('would not report a strip for a trusted run, so the assertion above discriminates', async () => {
    // Positive control for the strip: the same call with a trusted tier must
    // NOT come back `contributorStripped`, whatever else it decides.
    const resolved = await resolveInstallSecrets({
      registries: [{ url: 'https://npm.example.com', tokenSecret: 'prod:NPM_TOKEN' }] as never,
      installEnv: ['prod:BUILD_TOKEN'],
      allowHttpNpmRegistries: false,
      resolvedOrgId: 'org-1',
      trustResolution: replay(TRUSTED).trustResolution,
      contextStore: undefined,
      secretResolver: undefined,
      protectionContext: {} as never,
      skipProtectionGate: true,
    });
    expect(resolved).not.toMatchObject({ contributorStripped: true });
  });

  it('drops the non-serializable deps and bundle, so the replay re-attaches live ones', () => {
    // A stored bundle would be a stale provider bundle — the wrong app, the
    // wrong credentials, and a check poster writing to the wrong place.
    const stored = toSerializableInputs(heldContext(UNTRUSTED)) as Record<string, unknown>;
    expect(stored).not.toHaveProperty('deps');
    expect(stored).not.toHaveProperty('bundle');
    expect(replay(UNTRUSTED).deps).toBe(LIVE_DEPS);
  });
});

/**
 * Pending-claim store for the event scaler backend.
 *
 * When the event backend spawns, it registers a pending claim and emits a
 * scale-up event carrying a single-use `claimCode` (never the token itself).
 * The provisioning workflow forwards that code to the instance it boots, and the
 * agent exchanges it — over the `scaler.claim-credentials` RPC — for a freshly
 * minted ephemeral agent token it then registers with. The claim code is the
 * authorization for that RPC, so the agent can redeem it before it authenticates
 * or registers; a workflow can also redeem the code itself and deliver the token.
 * The token is therefore minted lazily (only when a real provision claims it) and
 * is single-use: a leaked or replayed claim code mints nothing.
 *
 * The claim is persisted in `scaler_pending_claims` rather than held in a
 * per-process map, so a code minted by one coordinator can be redeemed by any
 * other coordinator behind the same shared endpoint. Only the sha256 of the
 * code is stored, so a DB read can never hand back a redeemable secret.
 */

import { randomBytes } from 'node:crypto';

import { sha256 } from '@kici-dev/shared';

import type { ScalerStateStore } from './scaler-state-store.js';

/**
 * TTL (seconds) a pending claim code stays redeemable when the scaler entry
 * does not set `claimTtlSeconds`. Long enough for a provisioning workflow to
 * boot an instance, short enough that a leaked code ages out quickly.
 */
export const DEFAULT_CLAIM_TTL_SECONDS = 300;

/**
 * Function that mints an ephemeral agent token bound to an agent id + labels.
 * Modelled on `AgentTokenStore.createEphemeral(agentId, labels, ttlMs)`.
 */
export type CreateEphemeralToken = (
  agentId: string,
  labels: string[],
  ttlMs: number,
) => Promise<string>;

/** What the event backend registers when it emits a scale-up. */
export interface ClaimSpec {
  /** Agent id the provisioned instance must register with. */
  agentId: string;
  /** Exact label set the ephemeral token is authorized for. */
  labels: string[];
  /** Mandatory (taint) labels the pool gates on, carried for the workflow. */
  mandatoryLabels: string[];
  /** TTL of the ephemeral agent token minted on claim (seconds). */
  agentTokenTtlSeconds: number;
  /** Orchestrator WS URL the provisioned agent connects back to. */
  orchestratorUrl: string;
}

/** What a successful claim returns to the provisioning workflow. */
export interface ClaimedCredentials {
  /** The freshly minted, single-use-per-claim ephemeral agent token. */
  agentToken: string;
  /** Agent id the instance must register with. */
  agentId: string;
  /** Orchestrator WS URL to connect back to. */
  orchestratorUrl: string;
  /** Labels the token authorizes. */
  labels: string[];
}

export interface ClaimStoreOptions {
  /** Mints the ephemeral agent token when a claim is honored. */
  createEphemeral: CreateEphemeralToken;
  /** Shared persistence, so any coordinator can redeem a code. */
  stateStore: ScalerStateStore;
  /**
   * Scaler this store belongs to; recorded on each claim row. Required for
   * `register`, and omitted on a redemption-only store (the manager's), which
   * never writes a row.
   */
  scalerName?: string;
  /** Injected clock (epoch ms) — no ambient `Date.now()` so TTLs are testable. */
  now?: () => number;
  /** Default TTL of a pending claim code (seconds) before it expires. */
  ttlDefaultSec: number;
}

/**
 * Shared store of pending provisioning claims, backed by `scaler_pending_claims`.
 */
export class ClaimStore {
  private readonly createEphemeral: CreateEphemeralToken;
  private readonly stateStore: ScalerStateStore;
  private readonly scalerName: string | undefined;
  private readonly now: () => number;
  private ttlDefaultMs: number;

  constructor(opts: ClaimStoreOptions) {
    this.createEphemeral = opts.createEphemeral;
    this.stateStore = opts.stateStore;
    this.scalerName = opts.scalerName;
    this.now = opts.now ?? (() => Date.now());
    this.ttlDefaultMs = opts.ttlDefaultSec * 1000;
  }

  /**
   * Replace the default pending-claim TTL. Called when a config reload changes
   * the owning scaler's `claimTtlSeconds`, so the new value applies without an
   * orchestrator restart.
   */
  setDefaultTtlSeconds(seconds: number): void {
    this.ttlDefaultMs = seconds * 1000;
  }

  /**
   * Register a pending claim and return its single-use code. The code is a
   * 256-bit cryptographically-random token — unguessable, so it can travel in
   * the (persisted) scale-up event without leaking the agent token. Only the
   * sha256 of the code is persisted, so a DB read can never hand back a
   * redeemable secret.
   */
  async register(spec: ClaimSpec): Promise<string> {
    const code = randomBytes(32).toString('hex');
    await this.stateStore.registerClaim({
      claimHash: sha256(code),
      claimPrefix: code.slice(0, 12),
      agentId: spec.agentId,
      scalerName: this.requireScalerName(),
      labels: spec.labels,
      agentTokenTtlMs: spec.agentTokenTtlSeconds * 1000,
      orchestratorUrl: spec.orchestratorUrl,
      expiresAt: new Date(this.now() + this.ttlDefaultMs),
    });
    return code;
  }

  /**
   * Exchange a claim code for freshly minted credentials. Single-use and
   * TTL-bounded, enforced by a conditional UPDATE that commits the consumption
   * BEFORE the mint is attempted — so two concurrent claims of one code, on any
   * two instances, can never both mint. Fail-closed: a failed mint does not
   * reopen the code.
   *
   * The redeem is one round trip on the happy path; `describeClaim` runs only
   * when the redeem found nothing, to say why (unknown / consumed / expired).
   */
  async claim(code: string): Promise<ClaimedCredentials> {
    const claimHash = sha256(code);
    const redeemed = await this.stateStore.redeemClaim(claimHash);
    if (!redeemed) {
      const state = await this.stateStore.describeClaim(claimHash);
      if (!state) throw new Error('invalid claim code');
      if (state.consumed) throw new Error('claim code already consumed');
      throw new Error('claim code expired');
    }

    const agentToken = await this.createEphemeral(
      redeemed.agentId,
      redeemed.labels,
      redeemed.agentTokenTtlMs,
    );
    return {
      agentToken,
      agentId: redeemed.agentId,
      orchestratorUrl: redeemed.orchestratorUrl,
      labels: redeemed.labels,
    };
  }

  /**
   * Drop every claim for an agent id, so a torn-down provision's code can no
   * longer be redeemed on any instance.
   */
  async invalidate(agentId: string): Promise<void> {
    await this.stateStore.invalidateClaimsForAgent(agentId);
  }

  /**
   * A redemption-only store never writes a claim row, so it is constructed
   * without a scaler name. Reaching `register` without one is a wiring bug, not
   * a runtime condition — fail loudly rather than persisting a row nothing can
   * attribute.
   */
  private requireScalerName(): string {
    if (!this.scalerName) {
      throw new Error('ClaimStore.register requires a scalerName');
    }
    return this.scalerName;
  }
}

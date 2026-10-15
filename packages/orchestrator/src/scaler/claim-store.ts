/**
 * Pending-claim store for the event scaler backend.
 *
 * A spawn registers a pending claim and emits a scale-up event carrying a
 * single-use `claimCode`, never the token. The booted instance (or the workflow
 * itself) redeems the code over the `scaler.claim-credentials` RPC for a freshly
 * minted ephemeral agent token. The code is that RPC's authorization, so it is
 * redeemable before the agent authenticates or registers. The token is minted
 * lazily and single-use: a leaked or replayed code mints nothing.
 *
 * Claims live in `scaler_pending_claims`, not a per-process map, so any
 * coordinator behind the same shared endpoint can redeem a code. Only the code's
 * sha256 is stored, so a DB read never hands back a redeemable secret.
 */

import { randomBytes } from 'node:crypto';

import { sha256 } from '@kici-dev/shared';

import type { ScalerStateStore } from './scaler-state-store.js';

/**
 * Pending claim TTL (seconds) when the scaler entry sets no `claimTtlSeconds`:
 * long enough to boot an instance, short enough that a leaked code ages out.
 */
export const DEFAULT_CLAIM_TTL_SECONDS = 300;

/** Mints an ephemeral agent token; modelled on `AgentTokenStore.createEphemeral`. */
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
  /** TTL of the ephemeral agent token minted on claim (seconds). */
  agentTokenTtlSeconds: number;
  /** Orchestrator WS URL the provisioned agent connects back to. */
  orchestratorUrl: string;
}

/** What a successful claim returns to the provisioning workflow. */
export interface ClaimedCredentials {
  /** Minted fresh on each claim. */
  agentToken: string;
  agentId: string;
  orchestratorUrl: string;
  labels: string[];
}

export interface ClaimStoreOptions {
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
  /** Default pending claim code TTL (seconds). */
  ttlDefaultSec: number;
}

/** Shared store of pending provisioning claims, backed by `scaler_pending_claims`. */
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

  /** Applies a reloaded `claimTtlSeconds` without an orchestrator restart. */
  setDefaultTtlSeconds(seconds: number): void {
    this.ttlDefaultMs = seconds * 1000;
  }

  /**
   * Register a pending claim and return its single-use code: 256 random bits,
   * so it can travel in the persisted scale-up event without leaking the token.
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
   * Reaching `register` on a redemption-only store is a wiring bug: fail loudly
   * rather than persist a row nothing can attribute.
   */
  private requireScalerName(): string {
    if (!this.scalerName) {
      throw new Error('ClaimStore.register requires a scalerName');
    }
    return this.scalerName;
  }
}

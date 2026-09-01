/**
 * Typed KiCI API available to workflows via ctx.kici.
 *
 * Each namespace groups related methods. Under the hood, calls are serialized
 * to { method: 'namespace.method', params } and sent over the agent's WS
 * connection to the orchestrator. Adding a new API method:
 *
 * 1. Add the typed method here (with param + return types)
 * 2. Register the handler in the orchestrator's AgentApiRegistry
 */

import {
  OIDC_TOKEN_REQUEST_METHOD,
  type OidcTokenResult,
} from '@kici-dev/engine/protocol/messages/oidc-token-relay';
import { GIT_CREDENTIAL_REQUEST_METHOD } from '@kici-dev/engine/protocol/messages/git-credential-relay';
import type { GitApi, GitGrant } from './git-types.js';
import type { HostInventoryEntry, InventorySelector } from '@kici-dev/engine';

export type { OidcTokenResult };
export type { HostInventoryEntry, InventorySelector };

// --- Infrastructure API ---

export interface InfrastructureListResult {
  scalers: Array<{
    name: string;
    type: string;
    labelSets: string[][];
    /** 'local' for this orchestrator's scalers, peer instanceId for remote. */
    source: string;
  }>;
  agents: Array<{
    agentId: string;
    labels: string[];
    scalerManaged: boolean;
    /** 'local' for this orchestrator's agents, peer instanceId for remote. */
    source: string;
  }>;
}

export interface InfrastructureApi {
  /** List available scalers and connected agents. */
  list(): Promise<InfrastructureListResult>;
}

// --- OIDC API ---

export interface OidcApi {
  /**
   * Request a short-lived OIDC ID token for the current job, bound to
   * `audience`. The token's identity claims (repository, ref, sha, run/job id)
   * are derived server-side from the build context and cannot be spoofed by the
   * workflow. The token is automatically masked in step logs. Only available
   * inside a running job step (throws otherwise).
   */
  token(opts: { audience: string }): Promise<OidcTokenResult>;
}

// --- Inventory API ---

export interface InventoryApi {
  /**
   * Query the host roster of the caller's orchestrator cluster. Omit the
   * selector ⇒ all hosts. Server-side filtering is label-based (reuses the
   * runsOnAll glob/regex matchers); filter on `properties` client-side in the
   * workflow. Available to steps and dynamic-job generators — a generator can
   * fan out one job per matching host. The roster is live, so a dynamic-job
   * generator inherits the same non-determinism contract as
   * `infrastructure.list()`.
   */
  query(selector?: InventorySelector): Promise<HostInventoryEntry[]>;
  /** Look up one host by agent id; null when the host is not in the roster. */
  get(agentId: string): Promise<HostInventoryEntry | null>;
}

// --- Host API ---

export interface HostApi {
  /**
   * Signal the orchestrator that the host this job runs on is about to reboot,
   * and resolve once the orchestrator acks (which sets a persisted
   * reboot-pending flag holding the pinned post-restart job). After this
   * resolves, the agent issues the OS reboot once the current step completes.
   *
   * Used by the SDK `restartHost()` step. `deadlineMs` overrides the
   * orchestrator's default host-reboot deadline. Only meaningful inside a
   * running job step on an agent; a local `kici run` rejects (no orchestrator
   * to ack, and a local run cannot reboot a remote host).
   */
  requestReboot(opts?: { deadlineMs?: number }): Promise<void>;
}

// --- Bootstrap API ---

/** Version-convergence status for a fleet host (the availability-gate probe). */
export interface AgentVersionStatus {
  /** The orchestrator's own version — the convergence target. */
  targetVersion: string;
  /** The version last staged onto the host, or null when never staged. */
  stagedVersion: string | null;
  /** True only when the target's payload objects exist for the host's platform. */
  available: boolean;
}

export interface BootstrapApi {
  /**
   * Bring up a temporary privileged init-runner on a declared-but-un-agented
   * host over SSH, so it auto-enrolls as a short-lived `kici:init` agent. The
   * step calling this must run on an agent holding the
   * `kici:capability:ssh-transport` capability (the orchestrator refuses
   * otherwise). No-op (`broughtUp: false`) when the target already has a live
   * agent. Each bring-up is access-logged.
   *
   * The target's reach metadata + the bring-up SSH key (a scoped secret) are
   * resolved server-side from the host roster — the workflow author supplies
   * only the target agent id.
   */
  ensureInitRunner(targetAgentId: string): Promise<{ broughtUp: boolean }>;

  /**
   * Ship an input to a host's pre-boot SSH channel (e.g. a LUKS passphrase to
   * a dropbear/initramfs `cryptroot-unlock` prompt on port 2222). Generic
   * "pipe stdin to a forced-command endpoint"; the unlock recipe is
   * per-host-passphrase → `preBootSend` → `waitForHostAlive`. Same
   * `kici:capability:ssh-transport` gate + access-log as `ensureInitRunner`.
   *
   * `inputSecret` is a scoped-secret ref (`scope/key`) the orchestrator
   * resolves server-side; the plaintext never passes through the workflow.
   * Success is the send completing (the session drops as the box boots) —
   * compose `restartHost`/host-alive waits to confirm the boot.
   */
  preBootSend(
    targetAgentId: string,
    opts: { inputSecret: string; port?: number; command?: string },
  ): Promise<void>;

  /**
   * Read a fleet host's agent-version convergence status: the orchestrator's
   * target version, the version last staged on the host, and whether the
   * target's self-contained payloads are available for the host's platform. The
   * availability-gate probe the `agentVersionConverge()` check-step calls; a
   * `false` `available` means the convergence HOLDS the host (never a skew).
   */
  agentVersionStatus(targetAgentId: string): Promise<AgentVersionStatus>;

  /**
   * Re-stage a fleet host onto the orchestrator's version and restart its agent,
   * driven by THIS (ops) agent as an external actor over SSH — no
   * self-update-handoff. Availability-gated server-side: refuses when the target
   * version's payloads are unavailable. Returns `{ restaged: false }` when the
   * host is already on the target version. The step calling this must run on an
   * agent holding `kici:capability:ssh-transport`.
   */
  restageAgent(targetAgentId: string): Promise<{ restaged: boolean }>;
}

// --- Event-scaler credential claim ---

/** Credentials a provisioning workflow uses to boot a scaler-provisioned agent. */
export interface ClaimedAgentCredentials {
  /** Single-use ephemeral agent token the provisioned instance registers with. */
  agentToken: string;
  /** Agent id the instance must register with (chosen by the scaler). */
  agentId: string;
  /** Orchestrator WS URL the instance connects back to. */
  orchestratorUrl: string;
  /** Labels the token authorizes. */
  labels: string[];
}

export interface ScalerApi {
  /**
   * Exchange a single-use claim code — delivered on a `kici.scaler.scale-up`
   * event to a provisioning workflow — for freshly minted ephemeral agent
   * credentials. Boot a cloud instance whose agent registers with the returned
   * `agentId` and `agentToken`, and the pending bound job runs on it. The token
   * is minted lazily on this call and never appears in the persisted event log.
   */
  claimAgentCredentials(claimCode: string): Promise<ClaimedAgentCredentials>;
}

// --- Top-level KiCI API ---

export interface KiciApi {
  /** Query orchestrator infrastructure (scalers, agents). */
  infrastructure: InfrastructureApi;
  /** Query the host roster / inventory (labels + typed properties). */
  inventory: InventoryApi;
  /** Request short-lived OIDC ID tokens for the current job (build provenance). */
  oidc: OidcApi;
  /** Forge-typed git credentials for the current job. */
  git: GitApi;
  /** Host-lifecycle operations on the agent's own host (e.g. reboot). */
  host: HostApi;
  /** Fresh-box bootstrap bring-up (init-runner over SSH, pre-boot unlock). */
  bootstrap: BootstrapApi;
  /** Event-scaler provisioning: claim ephemeral agent credentials. */
  scaler: ScalerApi;
}

// --- Transport layer (internal) ---

/**
 * Low-level transport function used to implement KiciApi.
 * Maps to sendApiRequest on OrchestratorClient or IPC relay in sandbox.
 */
export type KiciApiTransport = (
  method: string,
  params?: Record<string, unknown>,
) => Promise<unknown>;

/**
 * Build a typed KiciApi proxy from a raw transport function.
 *
 * This is the bridge between the typed SDK interface and the untyped WS/IPC
 * transport. Each method call is mapped to { method: 'namespace.method', params }.
 *
 * `jobCtx` carries the per-job execution context (the job the step is running
 * in). It is supplied by the agent's sandbox step context so `oidc.token()` can
 * bind its request to that job; the workflow author never supplies it. It is
 * omitted for contexts with no running job (e.g. DynamicJobFn re-evaluation),
 * where `oidc.token()` throws rather than silently misattributing a token.
 */
export function buildKiciApi(transport: KiciApiTransport, jobCtx?: { jobId: string }): KiciApi {
  return {
    infrastructure: {
      list: () => transport('infrastructure.list', {}) as Promise<InfrastructureListResult>,
    },
    inventory: {
      // `inventory` works without `jobCtx` (unlike `oidc.token`): the roster is
      // cluster-scoped, not job-bound, so it is available to dynamic-job
      // re-evaluation as well as steps.
      query: (selector) =>
        transport('inventory.query', { ...(selector ?? {}) }) as Promise<HostInventoryEntry[]>,
      get: (agentId) =>
        transport('inventory.get', { agentId }) as Promise<HostInventoryEntry | null>,
    },
    oidc: {
      token: (opts) => {
        if (!jobCtx) {
          return Promise.reject(
            new Error('ctx.kici.oidc.token() is only available inside a running job step'),
          );
        }
        return transport(OIDC_TOKEN_REQUEST_METHOD, {
          jobId: jobCtx.jobId,
          audience: opts.audience,
        }) as Promise<OidcTokenResult>;
      },
    },
    git: {
      github: {
        getToken: (opts) => {
          if (!jobCtx) {
            return Promise.reject(
              new Error(
                'ctx.kici.git.github.getToken() is only available inside a running job step',
              ),
            );
          }
          if (opts.repositories.length === 0) {
            // An empty list would mint across the whole installation. Refuse:
            // a write grant must always name a specific repository.
            return Promise.reject(
              new Error('git.github.getToken requires at least one repository'),
            );
          }
          return transport(GIT_CREDENTIAL_REQUEST_METHOD, {
            jobId: jobCtx.jobId,
            repositories: opts.repositories,
            permissions: opts.permissions,
            ...(opts.credential ? { credential: opts.credential } : {}),
          }).then((raw) => {
            const r = raw as { secret: string; expiresAt: string | null; grant: GitGrant };
            return { token: r.secret, expiresAt: r.expiresAt, granted: r.grant };
          });
        },
      },
    },
    host: {
      requestReboot: (opts) =>
        transport('host.requestReboot', {
          ...(opts?.deadlineMs !== undefined ? { deadlineMs: opts.deadlineMs } : {}),
        }) as Promise<void>,
    },
    bootstrap: {
      // The agent process intercepts these methods: it relays the privileged
      // half to the orchestrator (which gates + mints + resolves + audits) and
      // performs the SSH transport itself, returning only the safe result. The
      // SSH key / bootstrap token never cross back into this sandbox.
      ensureInitRunner: (targetAgentId) =>
        transport('kici.ensureInitRunner', { targetAgentId }) as Promise<{ broughtUp: boolean }>,
      preBootSend: (targetAgentId, opts) =>
        transport('kici.preBootSend', { targetAgentId, ...opts }) as Promise<void>,
      // A pure read (no SSH) — relayed straight to the orchestrator.
      agentVersionStatus: (targetAgentId) =>
        transport('kici.agentVersionStatus', { targetAgentId }) as Promise<AgentVersionStatus>,
      // Intercepted in the agent process (external-actor SSH re-stage); the
      // orchestrator's privileged resolve is availability-gated + audited.
      restageAgent: (targetAgentId) =>
        transport('kici.restageAgent', { targetAgentId }) as Promise<{ restaged: boolean }>,
    },
    scaler: {
      // The agent process intercepts this method: it relays it to the
      // orchestrator over the dedicated `scaler.claim-credentials` WS message
      // (the token rides that response only, never the persisted event log).
      claimAgentCredentials: (claimCode) =>
        transport('scaler.claim-credentials', { claimCode }) as Promise<ClaimedAgentCredentials>,
    },
  };
}

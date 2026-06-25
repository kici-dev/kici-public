/**
 * Orchestrator-side agent-API handlers for the bootstrap bring-up seam.
 *
 * Both `kici.ensureInitRunner` and `kici.preBootSend` ride the agent-WS RPC
 * channel (like `inventory.query` / `host.requestReboot`). The PRIVILEGED half
 * lives here — capability gate, scoped-secret resolve, single-use bootstrap
 * token mint, access-log — and the handler returns the SSH material to the
 * calling agent, which performs the actual SSH transport (it holds the mesh
 * path to the fresh box). The capability gate reads the CALLING agent's labels
 * from the registry; only an agent holding `kici:capability:ssh-transport` may
 * run a bring-up, and every attempt (allowed or denied) writes an access-log
 * row.
 */
import {
  hostLabel,
  INIT_LABEL,
  PRIVILEGED_ROOT_LABEL,
  SSH_TRANSPORT_CAPABILITY,
  type AccessLogAction,
} from '@kici-dev/engine';
import { z } from 'zod';
import {
  deriveHostStatus,
  HostStatus,
  type HostReach,
  type HostRosterStore,
} from '../agent/host-roster.js';
import type { AgentRegistry } from '../agent/registry.js';
import type { AgentTokenStore } from '../agent/token-store.js';
import type { SecretResolver } from '../secrets/secret-resolver.js';
import type { AccessLogWriter } from '../audit/access-log.js';

/** Bootstrap token TTL: short by design — a leaked token is inert after it. */
export const BOOTSTRAP_TOKEN_TTL_MS = 10 * 60 * 1000;

/** Default pre-boot dropbear/initramfs SSH port for `preBootSend`. */
export const PRE_BOOT_DEFAULT_PORT = 2222;

/** Default forced command at a dropbear unlock endpoint (ignored by `-c` forces). */
export const PRE_BOOT_DEFAULT_COMMAND = 'cryptroot-unlock';

/** Shared deps for the bring-up handlers. */
export interface BringupApiDeps {
  registry: AgentRegistry;
  rosterStore: HostRosterStore;
  tokenStore: AgentTokenStore;
  secretResolver: SecretResolver;
  accessLog: AccessLogWriter;
  graceMs: number;
  /** Resolve the orchestrator's tenant org id (single-tenant ⇒ `__default__`). */
  resolveOrgId: () => string;
  /** Resolve the orchestrator WS URL the init-runner should dial. */
  resolveOrchestratorUrl: () => string;
}

/**
 * Reach the calling agent connects to + the resolved private key. Returned to
 * the agent so it can run the SSH transport. The key value transits to the ops
 * agent by design (it custodies the bring-up key), exactly as resolved secrets
 * reach an agent at job dispatch.
 */
export interface BringupReach {
  agentId: string;
  address: string | null;
  sshUser: string | null;
  sshPort: number | null;
}

/** Result the agent receives for an `ensureInitRunner` call. */
export interface EnsureInitRunnerResult {
  broughtUp: boolean;
  reach?: BringupReach;
  privateKey?: string;
  bootstrapToken?: string;
  targetAgentId?: string;
  orchestratorUrl?: string;
  /** The init-runner label set the bootstrap token is bound to. */
  labels?: string[];
}

/** Result the agent receives for a `preBootSend` call. */
export interface PreBootSendResult {
  reach: BringupReach;
  /** The host's bring-up SSH private key — needed to authenticate to dropbear. */
  privateKey: string;
  /** The resolved pre-boot input (e.g. LUKS passphrase) to pipe to the prompt. */
  input: string;
  port: number;
  command: string;
}

const ensureParamsSchema = z.object({ targetAgentId: z.string().min(1) });
const preBootParamsSchema = z.object({
  targetAgentId: z.string().min(1),
  inputSecret: z.string().min(1),
  port: z.number().int().positive().optional(),
  command: z.string().min(1).optional(),
});

/** Thrown when the caller lacks `kici:capability:ssh-transport`. */
export class CapabilityDeniedError extends Error {
  constructor(callingAgentId: string) {
    super(
      `agent ${callingAgentId} lacks ${SSH_TRANSPORT_CAPABILITY} capability required for bring-up`,
    );
    this.name = 'CapabilityDeniedError';
  }
}

/** True when the agent currently holds the ssh-transport capability label. */
function hasSshTransport(deps: BringupApiDeps, callingAgentId: string): boolean {
  return deps.registry.get(callingAgentId)?.labels.has(SSH_TRANSPORT_CAPABILITY) ?? false;
}

/** Write one access-log row for a bring-up attempt (best-effort). */
function recordBringup(
  deps: BringupApiDeps,
  action: AccessLogAction,
  callingAgentId: string,
  targetAgentId: string,
  outcome: 'allowed' | 'denied',
): void {
  void deps.accessLog.record({
    orgId: null,
    routingKey: null,
    // An ops agent is a service-account principal (a non-human orchestrator
    // tenant), targeting a fleet host over the agent-WS RPC plane.
    actor: { type: 'service_account', id: callingAgentId },
    action,
    target: { type: 'fleet', id: targetAgentId },
    requestId: null,
    source: 'agent',
    outcome,
  });
}

/** Resolve a `scope/key` secret ref into (scope, key). The key is the last segment. */
function splitSecretRef(ref: string): { scope: string; key: string } {
  const idx = ref.lastIndexOf('/');
  if (idx <= 0 || idx === ref.length - 1) {
    throw new Error(`malformed ssh_key_secret ref "${ref}" (expected scope/key)`);
  }
  return { scope: ref.slice(0, idx), key: ref.slice(idx + 1) };
}

/** Map a roster HostReach to the agent-facing BringupReach (drops the secret ref). */
function toBringupReach(reach: HostReach): BringupReach {
  return {
    agentId: reach.agentId,
    address: reach.address,
    sshUser: reach.sshUser,
    sshPort: reach.sshPort,
  };
}

/** Resolve a single `scope/key` secret ref to its value, or throw. */
async function resolveSecretRef(
  deps: BringupApiDeps,
  ref: string,
  targetAgentId: string,
): Promise<string> {
  const { scope, key } = splitSecretRef(ref);
  const value = await deps.secretResolver.resolveNamed(deps.resolveOrgId(), scope, key);
  if (value === null) {
    throw new Error(`secret ${ref} for host ${targetAgentId} resolved to nothing`);
  }
  return value;
}

/** Resolve a host's reach + its scoped SSH/secret value, or throw a clear error. */
async function resolveReachAndSecret(
  deps: BringupApiDeps,
  targetAgentId: string,
  secretRefOf: (reach: HostReach) => string | null,
): Promise<{ reach: HostReach; secretValue: string }> {
  const reach = await deps.rosterStore.getReach(targetAgentId);
  if (!reach) throw new Error(`host ${targetAgentId} is not in the roster`);
  if (!reach.address) throw new Error(`host ${targetAgentId} has no SSH reach address declared`);
  const ref = secretRefOf(reach);
  if (!ref) throw new Error(`host ${targetAgentId} has no secret ref declared for this operation`);
  const secretValue = await resolveSecretRef(deps, ref, targetAgentId);
  return { reach, secretValue };
}

/**
 * Build the `kici.ensureInitRunner` handler. No-ops when the target already has
 * a live agent; otherwise gates on the caller's capability, resolves the SSH
 * key, mints a single-use bootstrap token, audits, and returns the material the
 * agent needs to drop + start the init-runner over SSH.
 */
export function createEnsureInitRunnerHandler(
  deps: BringupApiDeps,
): (callingAgentId: string, params: Record<string, unknown>) => Promise<EnsureInitRunnerResult> {
  return async (callingAgentId, params) => {
    const { targetAgentId } = ensureParamsSchema.parse(params);

    if (!hasSshTransport(deps, callingAgentId)) {
      recordBringup(deps, 'fleet.init_runner.bringup', callingAgentId, targetAgentId, 'denied');
      throw new CapabilityDeniedError(callingAgentId);
    }

    // No-op when the target already has a live (connected + fresh) agent.
    const existing = await deps.rosterStore.get(targetAgentId);
    if (existing) {
      const status = deriveHostStatus(existing, Date.now(), deps.graceMs);
      if (status === HostStatus.ready) {
        recordBringup(deps, 'fleet.init_runner.bringup', callingAgentId, targetAgentId, 'allowed');
        return { broughtUp: false };
      }
    }

    const { reach, secretValue } = await resolveReachAndSecret(
      deps,
      targetAgentId,
      (r) => r.sshKeySecret,
    );

    const labels = [INIT_LABEL, PRIVILEGED_ROOT_LABEL, hostLabel(targetAgentId)];
    const { token } = await deps.tokenStore.mintBootstrapToken({
      targetAgentId,
      ttlMs: BOOTSTRAP_TOKEN_TTL_MS,
      labels,
    });

    recordBringup(deps, 'fleet.init_runner.bringup', callingAgentId, targetAgentId, 'allowed');

    return {
      broughtUp: true,
      reach: toBringupReach(reach),
      privateKey: secretValue,
      bootstrapToken: token,
      targetAgentId,
      orchestratorUrl: deps.resolveOrchestratorUrl(),
      labels,
    };
  };
}

/**
 * Build the `kici.preBootSend` handler. Gates on the caller's capability,
 * resolves the pre-boot input secret (e.g. a LUKS passphrase), audits, and
 * returns the input + reach so the agent can pipe it to the target's pre-boot
 * SSH endpoint.
 */
export function createPreBootSendHandler(
  deps: BringupApiDeps,
): (callingAgentId: string, params: Record<string, unknown>) => Promise<PreBootSendResult> {
  return async (callingAgentId, params) => {
    const parsed = preBootParamsSchema.parse(params);
    const targetAgentId = parsed.targetAgentId;

    if (!hasSshTransport(deps, callingAgentId)) {
      recordBringup(deps, 'fleet.pre_boot.send', callingAgentId, targetAgentId, 'denied');
      throw new CapabilityDeniedError(callingAgentId);
    }

    // Resolve BOTH the host's bring-up SSH key (to authenticate to dropbear)
    // and the pre-boot input (e.g. the LUKS passphrase to pipe to the prompt).
    const { reach, secretValue: privateKey } = await resolveReachAndSecret(
      deps,
      targetAgentId,
      (r) => r.sshKeySecret,
    );
    const input = await resolveSecretRef(deps, parsed.inputSecret, targetAgentId);

    recordBringup(deps, 'fleet.pre_boot.send', callingAgentId, targetAgentId, 'allowed');

    return {
      reach: toBringupReach(reach),
      privateKey,
      input,
      port: parsed.port ?? PRE_BOOT_DEFAULT_PORT,
      command: parsed.command ?? PRE_BOOT_DEFAULT_COMMAND,
    };
  };
}

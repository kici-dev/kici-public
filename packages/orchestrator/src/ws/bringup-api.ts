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
import { AgentDeliveryMode, AgentPlatform } from '@kici-dev/shared';
import {
  presignAgentPackageDownload,
  type AgentPackageDownloadStorage,
} from '../agent-packaging/download.js';
import { assertPayloadsAvailable } from '../agent-packaging/availability.js';
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
  /** Resolve the orchestrator's own version — the payload version to stage on bring-up. */
  resolveVersion: () => string;
  /**
   * The cache-bucket agent-package store, present only when S3 cache storage is
   * configured. Backs the `s3-direct` delivery mode: the handler mints a
   * box-routable presigned download URL for a probed platform. Absent ⇒ every
   * bring-up falls back to `ssh-push` and the presign RPC is refused.
   */
  agentPackages?: AgentPackageDownloadStorage;
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
  /** The orchestrator's own version — the self-contained payload version to stage. */
  version?: string;
  /**
   * Per-host delivery mode the agent uses to stage the payload: `s3-direct` when
   * the host is declared object-storage-reachable AND a cache store is
   * configured, else `ssh-push`. The agent probes the platform then requests the
   * presigned URL via `kici.presignAgentPackage` for the `s3-direct` case.
   */
  deliveryMode?: AgentDeliveryMode;
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

    // Record the staged version so the fleet-convergence gate can later detect
    // drift on this host (the agent's own self-reported bundle version cannot
    // distinguish two payloads that share a self-report but differ by staged
    // key). The bring-up stages the orchestrator's own version.
    const stagedVersion = deps.resolveVersion();
    await deps.rosterStore.recordStagedVersion(targetAgentId, stagedVersion);

    // Pick s3-direct only when the host is declared object-storage-reachable AND
    // a cache store is configured to mint the presign; otherwise the
    // conservative ssh-push fallback (the ops agent fetches + streams the bytes).
    const deliveryMode: AgentDeliveryMode =
      reach.s3Reachable === true && deps.agentPackages
        ? AgentDeliveryMode.enum['s3-direct']
        : AgentDeliveryMode.enum['ssh-push'];

    return {
      broughtUp: true,
      reach: toBringupReach(reach),
      privateKey: secretValue,
      bootstrapToken: token,
      targetAgentId,
      orchestratorUrl: deps.resolveOrchestratorUrl(),
      labels,
      version: deps.resolveVersion(),
      deliveryMode,
    };
  };
}

const presignParamsSchema = z.object({
  targetAgentId: z.string().min(1),
  platform: AgentPlatform,
});

/** Result the agent receives for a `presignAgentPackage` call. */
export interface PresignAgentPackageResult {
  url: string;
  /** The expected sha256 (hex), or null when the producer wrote no sidecar. */
  sha256: string | null;
}

/**
 * Build the `kici.presignAgentPackage` handler — the follow-up RPC the ops agent
 * calls AFTER it probes the target platform (so the presign is keyed by the real
 * platform). Same capability gate + access-log as the bring-up. Mints a
 * box-routable presigned GET URL for the version-keyed payload from the
 * orchestrator's own cache bucket; no standing S3 credential leaves the
 * orchestrator. A missing payload object throws loudly (never a silent stale
 * stage). Used by BOTH delivery paths: for `s3-direct` the URL goes to the box;
 * for `ssh-push` the ops agent fetches it and streams the bytes onward.
 */
export function createPresignAgentPackageHandler(
  deps: BringupApiDeps,
): (callingAgentId: string, params: Record<string, unknown>) => Promise<PresignAgentPackageResult> {
  return async (callingAgentId, params) => {
    const { targetAgentId, platform } = presignParamsSchema.parse(params);

    if (!hasSshTransport(deps, callingAgentId)) {
      recordBringup(deps, 'fleet.init_runner.bringup', callingAgentId, targetAgentId, 'denied');
      throw new CapabilityDeniedError(callingAgentId);
    }
    if (!deps.agentPackages) {
      recordBringup(deps, 'fleet.init_runner.bringup', callingAgentId, targetAgentId, 'denied');
      throw new Error(
        'agent-package object storage is not configured (set KICI_STORAGE_* / KICI_AGENT_BINARY_SOURCE) — cannot presign a payload',
      );
    }

    const version = deps.resolveVersion();
    const presigned = await presignAgentPackageDownload(deps.agentPackages, version, platform);
    if (!presigned) {
      recordBringup(deps, 'fleet.init_runner.bringup', callingAgentId, targetAgentId, 'denied');
      throw new Error(
        `no agent payload for version ${version} (${platform}) in the cache bucket — run \`kici-admin agent package --platform ${platform} --upload\``,
      );
    }

    recordBringup(deps, 'fleet.init_runner.bringup', callingAgentId, targetAgentId, 'allowed');
    return { url: presigned.url, sha256: presigned.sha256 };
  };
}

/**
 * Reserved `host_properties` keys carrying a permanent fleet agent's re-stage
 * hints: how to drain + restart it after an install swap, and where it lives.
 * Declared with `kici-admin host declare --property`; the `kici:` namespace is
 * orchestrator-reserved so an agent never reports them.
 */
const RESTART_STOP_KEY = 'kici:agent-restart-stop';
const RESTART_START_KEY = 'kici:agent-restart-start';
const INSTALL_DIR_KEY = 'kici:agent-install-dir';
const AGENT_SERVICE_KEY = 'kici:agent-service';

/** How the ops agent drains + restarts a re-staged host + where its install lives. */
export interface AgentRestartSpec {
  stop: string;
  start: string;
  installDir?: string;
}

/**
 * Map a roster row's os/arch tokens to an {@link AgentPlatform}, or null when the
 * host's platform is unknown / unsupported (so availability falls back to the
 * whole bootstrap set). Accepts both `uname` (`x86_64`/`aarch64`) and Node
 * (`x64`/`arm64`) arch spellings.
 */
export function archToAgentPlatform(
  platform: string | null,
  arch: string | null,
): AgentPlatform | null {
  if (platform !== null && platform !== 'linux') return null;
  if (arch === 'x64' || arch === 'x86_64') return AgentPlatform.enum['linux-x64'];
  if (arch === 'arm64' || arch === 'aarch64') return AgentPlatform.enum['linux-arm64'];
  return null;
}

/**
 * Derive the drain/restart spec from a host's declared properties. Explicit
 * stop/start commands win; otherwise a declared systemd service name maps to
 * `systemctl --user stop|start <svc>`. Returns null when neither is declared —
 * the orchestrator then cannot re-stage the host (it does not know how to
 * restart it) and the caller refuses loudly.
 */
export function resolveRestartSpec(properties: Record<string, unknown>): AgentRestartSpec | null {
  const installDir =
    typeof properties[INSTALL_DIR_KEY] === 'string'
      ? String(properties[INSTALL_DIR_KEY])
      : undefined;
  const stop = properties[RESTART_STOP_KEY];
  const start = properties[RESTART_START_KEY];
  if (typeof stop === 'string' && typeof start === 'string') {
    return { stop, start, ...(installDir ? { installDir } : {}) };
  }
  const service = properties[AGENT_SERVICE_KEY];
  if (typeof service === 'string' && service.length > 0) {
    // Defensively single-quote the service name so it cannot break out of the
    // systemctl argv (belt-and-suspenders on top of the reserved-namespace
    // strip that keeps these keys operator-declared, not agent-forgeable).
    const svc = `'${service.replace(/'/g, `'\\''`)}'`;
    return {
      stop: `systemctl --user stop ${svc} || true`,
      start: `systemctl --user start ${svc}`,
      ...(installDir ? { installDir } : {}),
    };
  }
  return null;
}

const versionTargetSchema = z.object({ targetAgentId: z.string().min(1) });

/** Result the check-step receives for a `kici.agentVersionStatus` read. */
export interface AgentVersionStatusResult {
  /** The orchestrator's own version — the convergence target. */
  targetVersion: string;
  /** The version last staged onto the host, or null when never staged. */
  stagedVersion: string | null;
  /** True only when the target's payload objects exist for the host's platform. */
  available: boolean;
}

/**
 * Build the `kici.agentVersionStatus` read handler — the availability-gate probe
 * the convergence check-step calls. Returns the target version, the host's
 * recorded staged version, and whether the target's payloads are available for
 * the host's platform (the whole bootstrap set when the platform is unknown). No
 * SSH, no token — a pure read, but same capability gate + audit as the bring-up.
 */
export function createAgentVersionStatusHandler(
  deps: BringupApiDeps,
): (callingAgentId: string, params: Record<string, unknown>) => Promise<AgentVersionStatusResult> {
  return async (callingAgentId, params) => {
    const { targetAgentId } = versionTargetSchema.parse(params);
    if (!hasSshTransport(deps, callingAgentId)) {
      recordBringup(deps, 'fleet.init_runner.bringup', callingAgentId, targetAgentId, 'denied');
      throw new CapabilityDeniedError(callingAgentId);
    }
    const targetVersion = deps.resolveVersion();
    const row = await deps.rosterStore.get(targetAgentId);
    if (!row) throw new Error(`host ${targetAgentId} is not in the roster`);
    const stagedVersion = await deps.rosterStore.getStagedVersion(targetAgentId);
    const platform = archToAgentPlatform(row.platform, row.arch);
    const platforms = platform ? [platform] : [...AgentPlatform.options];
    const available = deps.agentPackages
      ? (await assertPayloadsAvailable(deps.agentPackages, targetVersion, platforms)).available
      : false;
    recordBringup(deps, 'fleet.init_runner.bringup', callingAgentId, targetAgentId, 'allowed');
    return { targetVersion, stagedVersion, available };
  };
}

/** Material the ops agent receives for a `kici.restageAgent` call. */
export interface RestageAgentResult {
  /** How to SSH to the target host. */
  reach: BringupReach;
  /** The resolved bring-up private key (custodied by the ops agent). */
  privateKey: string;
  /** The target version to converge onto (the orchestrator's own). */
  version: string;
  /** Per-host delivery mode (`s3-direct` when reachable + a store is configured). */
  deliveryMode: AgentDeliveryMode;
  /** How the ops agent drains + restarts the host after the install swap. */
  restart: AgentRestartSpec;
}

/**
 * Build the `kici.restageAgent` handler — the availability-gated, external-actor
 * re-stage authorization. Gates on the caller's `ssh-transport` capability,
 * REFUSES loudly when the target version's payloads are unavailable for the
 * host's platform (belt-and-suspenders over the check-step gate — never a
 * skew), resolves the host reach + SSH key + restart spec, records the staged
 * version, audits, and returns the material the ops agent needs to swap + restart
 * the target's agent over SSH. Mints NO token: the re-staged permanent agent
 * reconnects on its own persistent credential (no self-update-handoff).
 */
export function createRestageAgentHandler(
  deps: BringupApiDeps,
): (callingAgentId: string, params: Record<string, unknown>) => Promise<RestageAgentResult> {
  return async (callingAgentId, params) => {
    const { targetAgentId } = versionTargetSchema.parse(params);
    if (!hasSshTransport(deps, callingAgentId)) {
      recordBringup(deps, 'fleet.init_runner.bringup', callingAgentId, targetAgentId, 'denied');
      throw new CapabilityDeniedError(callingAgentId);
    }

    const version = deps.resolveVersion();
    const row = await deps.rosterStore.get(targetAgentId);
    if (!row) throw new Error(`host ${targetAgentId} is not in the roster`);

    // Availability gate (fail-closed): never authorize a re-stage onto a version
    // whose payload objects don't exist — that would be a version skew.
    const platform = archToAgentPlatform(row.platform, row.arch);
    const platforms = platform ? [platform] : [...AgentPlatform.options];
    const gate = deps.agentPackages
      ? await assertPayloadsAvailable(deps.agentPackages, version, platforms)
      : { available: false, missing: platforms };
    if (!gate.available) {
      recordBringup(deps, 'fleet.init_runner.bringup', callingAgentId, targetAgentId, 'denied');
      throw new Error(
        `refusing to re-stage ${targetAgentId} to ${version}: payload unavailable for ${gate.missing.join(', ')} (run \`kici-admin agent package --upload\`)`,
      );
    }

    const restart = resolveRestartSpec(parseProps(row.host_properties));
    if (!restart) {
      recordBringup(deps, 'fleet.init_runner.bringup', callingAgentId, targetAgentId, 'denied');
      throw new Error(
        `host ${targetAgentId} declares no restart method (set ${AGENT_SERVICE_KEY} or ${RESTART_STOP_KEY}/${RESTART_START_KEY} via \`kici-admin host declare --property\`)`,
      );
    }

    const { reach, secretValue } = await resolveReachAndSecret(
      deps,
      targetAgentId,
      (r) => r.sshKeySecret,
    );
    const deliveryMode: AgentDeliveryMode =
      reach.s3Reachable === true && deps.agentPackages
        ? AgentDeliveryMode.enum['s3-direct']
        : AgentDeliveryMode.enum['ssh-push'];

    // Record the staged version as the orchestrator's intent-of-record. The
    // availability gate above already guaranteed the bytes exist; the on-box
    // stage verifies the hash before extracting, so a recorded version is never
    // a version whose payload is absent.
    await deps.rosterStore.recordStagedVersion(targetAgentId, version);
    recordBringup(deps, 'fleet.init_runner.bringup', callingAgentId, targetAgentId, 'allowed');

    return {
      reach: toBringupReach(reach),
      privateKey: secretValue,
      version,
      deliveryMode,
      restart,
    };
  };
}

/** Parse a stored host_properties value into a plain record (pg jsonb or string). */
function parseProps(value: unknown): Record<string, unknown> {
  const parsed = typeof value === 'string' ? JSON.parse(value) : value;
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
    ? (parsed as Record<string, unknown>)
    : {};
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

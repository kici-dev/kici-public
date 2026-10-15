/**
 * Orchestrator-side agent-API handlers for the bootstrap bring-up seam.
 *
 * These handlers ride the agent-WS RPC channel (like `inventory.query` /
 * `host.requestReboot`). The PRIVILEGED half lives here — capability gate,
 * scoped-secret resolve, single-use bootstrap token mint, access-log — and the
 * calling agent performs the SSH transport (it holds the mesh path to the fresh
 * box). Only a caller whose registry labels hold `kici:capability:ssh-transport`
 * may run a bring-up; every attempt (allowed or denied) writes an access-log row.
 */
import {
  canonicalizeLabel,
  hostLabel,
  INIT_LABEL,
  PRIVILEGED_ROOT_LABEL,
  SSH_TRANSPORT_CAPABILITY,
  type AccessLogAction,
} from '@kici-dev/engine';
import { AgentDeliveryMode, AgentPlatform, createLogger } from '@kici-dev/shared';
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
import { runDetached } from '../helpers/run-detached.js';

const logger = createLogger({ prefix: 'bringup-api' });

/** Bootstrap token TTL: short by design — a leaked token is inert after it. */
export const BOOTSTRAP_TOKEN_TTL_MS = 10 * 60 * 1000;

/** Default pre-boot dropbear/initramfs SSH port for `preBootSend`. */
export const PRE_BOOT_DEFAULT_PORT = 2222;

/** Default forced command at a dropbear unlock endpoint (ignored by `-c` forces). */
export const PRE_BOOT_DEFAULT_COMMAND = 'cryptroot-unlock';

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
   * Cache-bucket agent-package store, present only when S3 cache storage is
   * configured. Backs `s3-direct` delivery (a box-routable presigned download URL
   * per probed platform). Absent ⇒ every bring-up uses `ssh-push` and the presign
   * RPC is refused.
   */
  agentPackages?: AgentPackageDownloadStorage;
}

/**
 * Host reach returned to the calling agent for the SSH transport. The private
 * key returned beside it transits to the ops agent by design (it custodies the
 * bring-up key), exactly as resolved secrets reach an agent at job dispatch.
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
   * Payload delivery mode: `s3-direct` when the host is declared
   * object-storage-reachable AND a cache store is configured, else `ssh-push`.
   * The agent probes the platform, then requests the presigned URL via
   * `kici.presignAgentPackage`.
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
  // The registry stores canonical labels, so the reserved capability label is
  // folded before the lookup rather than compared raw.
  return (
    deps.registry.get(callingAgentId)?.labels.has(canonicalizeLabel(SSH_TRANSPORT_CAPABILITY)) ??
    false
  );
}

/** Write one access-log row for a bring-up attempt (best-effort). */
function recordBringup(
  deps: BringupApiDeps,
  action: AccessLogAction,
  callingAgentId: string,
  targetAgentId: string,
  outcome: 'allowed' | 'denied',
): void {
  runDetached(
    logger,
    'Access log write',
    () =>
      deps.accessLog.record({
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
      }),
    { agentId: targetAgentId },
  );
}

/** The key is the last `/` segment of a `scope/key` ref. */
function splitSecretRef(ref: string): { scope: string; key: string } {
  const idx = ref.lastIndexOf('/');
  if (idx <= 0 || idx === ref.length - 1) {
    throw new Error(`malformed ssh_key_secret ref "${ref}" (expected scope/key)`);
  }
  return { scope: ref.slice(0, idx), key: ref.slice(idx + 1) };
}

/** Drops the secret ref from the agent-facing reach. */
function toBringupReach(reach: HostReach): BringupReach {
  return {
    agentId: reach.agentId,
    address: reach.address,
    sshUser: reach.sshUser,
    sshPort: reach.sshPort,
  };
}

async function resolveSecretRef(
  deps: BringupApiDeps,
  ref: string,
  targetAgentId: string,
): Promise<string> {
  const { scope, key } = splitSecretRef(ref);
  const value = await deps.secretResolver.resolveNamedInternal(deps.resolveOrgId(), scope, key);
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

    // The fleet-convergence gate detects drift from this record: the agent's
    // self-reported bundle version cannot tell apart two payloads that share a
    // self-report but differ by staged key.
    const stagedVersion = deps.resolveVersion();
    await deps.rosterStore.recordStagedVersion(targetAgentId, stagedVersion);

    // ssh-push fallback: the ops agent fetches + streams the bytes.
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
 * Build the `kici.presignAgentPackage` handler, which the ops agent calls AFTER
 * it probes the target platform, so the presign is keyed by the real platform.
 * Same capability gate + access-log as the bring-up. Mints a box-routable
 * presigned GET URL for the version-keyed payload in the orchestrator's cache
 * bucket; no standing S3 credential leaves the orchestrator. A missing payload
 * throws loudly (never a silent stale stage). For `s3-direct` the URL goes to
 * the box; for `ssh-push` the ops agent fetches it and streams the bytes onward.
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
 * Only a local `kici-admin host declare --prop` sets them: a registering agent's
 * reserved keys are stripped and a dashboard declare that names one is refused.
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
    // Single-quote the service name so it cannot break out of the systemctl argv
    // (on top of the reserved-namespace guard that keeps these keys
    // operator-declared, not agent-forgeable).
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
 * Build the `kici.agentVersionStatus` read handler: the availability-gate probe
 * the convergence check-step calls. Availability covers the host's platform, or
 * the whole bootstrap set when the platform is unknown. No SSH, no token — a
 * pure read, with the same capability gate + audit as the bring-up.
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
 * Build the `kici.restageAgent` handler: the availability-gated, external-actor
 * re-stage authorization. Gates on the caller's `ssh-transport` capability and
 * REFUSES loudly when the target version's payloads are unavailable for the
 * host's platform (a second gate over the check-step's — never a skew). Returns
 * what the ops agent needs to swap + restart the target's agent over SSH. Mints
 * NO token: the re-staged permanent agent reconnects on its own persistent
 * credential (no self-update-handoff).
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

    // Fail-closed: a re-stage onto a version whose payloads don't exist is a skew.
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
        `host ${targetAgentId} declares no restart method (set ${AGENT_SERVICE_KEY} or ${RESTART_STOP_KEY}/${RESTART_START_KEY} via \`kici-admin host declare --prop\`)`,
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

    // The staged version is the orchestrator's intent-of-record. The gate above
    // guarantees the bytes exist and the on-box stage verifies the hash before
    // extracting, so a recorded version never has an absent payload.
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
 * Build the `kici.preBootSend` handler. Gates on the caller's capability and
 * returns the resolved pre-boot input (e.g. a LUKS passphrase) + reach so the
 * agent can pipe it to the target's pre-boot SSH endpoint.
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

    // The bring-up SSH key authenticates to dropbear.
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

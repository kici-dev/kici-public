/**
 * Bare-metal scaler backend implementation.
 *
 * Manages ephemeral agent processes using child_process.spawn.
 * Uses detached process groups for clean killing of entire process trees.
 * All agents are single-use: destroyed after job completion.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { PassThrough } from 'node:stream';
import { createInterface } from 'node:readline';
import {
  ALLOWED_SYSTEM_VARS,
  KICI_AGENT_ENV_PREFIX,
  scalerAgentLabels,
  ScalerBackendType,
} from '@kici-dev/engine';
import { createLogger, type ToolRequirement } from '@kici-dev/shared';
import { normalizeLabelSet } from './label-matcher.js';
import { ScalerEventType } from './types.js';
import type { AgentTokenStore } from '../agent/token-store.js';
import type {
  ScalerBackend,
  ScalerEntry,
  ManagedAgent,
  LabelSetConfig,
  LogCapture,
  ResourceRequest,
  ScalerEventCallback,
  ValidationResult,
  EffectiveLimits,
} from './types.js';

/** Extended ManagedAgent that includes the ChildProcess reference */
interface BareMetalManagedAgent extends ManagedAgent {
  process: ChildProcess;
}

export interface BareMetalScalerBackendOptions {
  /** Human-readable name for this scaler */
  name: string;
  /** Label sets this backend can provision */
  labelSets: LabelSetConfig[];
  /** Maximum concurrent agents */
  maxAgents: number;
  /** Default resource limits applied when label set has none */
  defaultResources?: ResourceRequest;
  /** Token store for creating ephemeral agent auth tokens. Optional -- when undefined, no token is injected. */
  tokenStore?: AgentTokenStore;
  /** TTL for ephemeral agent tokens in ms. Default: 1 hour. */
  tokenTtlMs?: number;
  /** Agent roles for this scaler. undefined = all, [] = execution only. */
  roles?: string[];
  /**
   * When true, wrap each spawned agent process in a transient systemd scope
   * (`systemd-run --user --scope --slice=kici-scaler`) and translate the
   * job's effective CPU / memory limits into `CPUQuota=` / `MemoryMax=`
   * properties so the kernel cgroup actually enforces the limits. When
   * false (the default), bare-metal stays its historical "advisory limits
   * only" mode — limits drive the scaler's per-machine cap math but no
   * cgroup is created.
   *
   * Linux-only. On macOS / Windows hosts the option is silently a no-op
   * (`systemd-run` does not exist), with a one-time startup warning.
   */
  enforceCgroups?: boolean;
}

export class BareMetalScalerBackend implements ScalerBackend {
  readonly type = ScalerBackendType.enum['bare-metal'];
  readonly spawnsOnLocalHost = true;
  readonly logsSource = 'bare-metal';
  readonly maxAgents: number;

  private _labelSets: LabelSetConfig[];
  private readonly name: string;
  private readonly defaultResources?: ResourceRequest;
  private readonly tokenStore?: AgentTokenStore;
  private readonly tokenTtlMs: number;
  private readonly roles: string[] | undefined;
  private readonly enforceCgroups: boolean;

  /** Tracks all managed agent processes */
  private readonly agents = new Map<string, BareMetalManagedAgent>();
  /** LogCapture instances for each managed agent (keyed by ManagedAgent.id) */
  private readonly logCaptures = new Map<string, LogCapture>();

  constructor(options: BareMetalScalerBackendOptions) {
    this.name = options.name;
    this._labelSets = options.labelSets;
    this.maxAgents = options.maxAgents;
    this.defaultResources = options.defaultResources;
    this.tokenStore = options.tokenStore;
    this.tokenTtlMs = options.tokenTtlMs ?? 3_600_000; // 1 hour default
    this.roles = options.roles;
    this.enforceCgroups = options.enforceCgroups ?? false;

    // One-time startup warning about bare-metal trust model
    const logger = createLogger({ prefix: 'bare-metal-backend' });
    logger.warn(
      `Bare-metal scaler "${options.name}" configured. Bare-metal agents run as child processes ` +
        `with full host filesystem and network access. This mode is intended for trusted environments only.`,
    );
    logger.warn(
      `Consider enabling bubblewrap (bwrap) for process isolation. See docs/operator/agent-security.md`,
    );

    if (this.enforceCgroups && process.platform !== 'linux') {
      logger.warn(
        `Bare-metal scaler "${options.name}" has enforceCgroups: true, but this host is ` +
          `${process.platform} -- systemd-run is unavailable. CPU/memory limits will be advisory ` +
          `(no kernel enforcement) on this platform.`,
      );
    } else if (this.enforceCgroups) {
      logger.info(
        `Bare-metal scaler "${options.name}" will wrap spawned agents in transient systemd scopes ` +
          `(slice=kici-scaler) and apply CPU/memory limits via systemd properties.`,
      );
    }

    this.warnNetworkPolicy(options.labelSets, logger);
  }

  private warnNetworkPolicy(
    labelSets: LabelSetConfig[],
    logger: ReturnType<typeof createLogger>,
  ): void {
    const count = labelSets.filter((ls) => ls.networkPolicy).length;
    if (count > 0) {
      logger.warn(
        `Bare-metal scaler "${this.name}" has ${count} label set(s) with networkPolicy configured. ` +
          `Network policies are not enforced for bare-metal agents (no network isolation boundary). ` +
          `Consider using container or Firecracker backends for network-isolated workloads.`,
      );
    }
  }

  /**
   * Declare required tools for a bare-metal scaler entry.
   *
   * - Every label set's `binaryPath` must be an executable file on disk.
   * - If `KICI_SANDBOX=true` will be forwarded to spawned agents (either via
   *   the orchestrator's `KICI_AGENT_ENV_KICI_SANDBOX=true` env var or via a
   *   label set's `env.KICI_SANDBOX=true` in scalers.yaml), then `bwrap` must
   *   be available on PATH so the agent can actually wrap workflow runners.
   *
   *   This check runs at orchestrator startup so misconfiguration fails
   *   fast with a clear error instead of crashing every job at dispatch
   *   time. On macOS and Windows (where bwrap does not exist) any attempt
   *   to enable KICI_SANDBOX will be rejected here.
   */
  static getRequiredTools(entry: ScalerEntry): ToolRequirement[] {
    const requirements: ToolRequirement[] = entry.labelSets
      .filter((ls) => ls.binaryPath)
      .map((ls) => ({
        type: 'file-access' as const,
        path: ls.binaryPath!,
        mode: 'executable' as const,
        reason: `agent binary for bare-metal scaler "${entry.name}"`,
      }));

    // The shipped kici-agent binary is a `#!/usr/bin/env node` script, so the
    // orchestrator's PATH (which the bare-metal backend forwards to the spawned
    // agent) must resolve `node`. Without this the agent dies at job time with
    // `env: 'node': No such file or directory` — fail fast at startup instead.
    requirements.push({
      type: 'path-binary',
      name: 'node',
      reason:
        `bare-metal scaler "${entry.name}" spawns the kici-agent node script. ` +
        `node must be on the orchestrator's PATH (it is forwarded to spawned agents). ` +
        `Ensure the orchestrator service's PATH includes your node install (e.g. the ` +
        `systemd unit's Environment=PATH covers the mise/nvm node bin dir).`,
    });

    // KICI_SANDBOX opt-in check. Either source requires bwrap at runtime.
    const sandboxViaGlobalEnv = process.env.KICI_AGENT_ENV_KICI_SANDBOX === 'true';
    const sandboxViaLabelSet = entry.labelSets.some(
      (ls) => ls.env && ls.env.KICI_SANDBOX === 'true',
    );
    if (sandboxViaGlobalEnv || sandboxViaLabelSet) {
      requirements.push({
        type: 'path-binary',
        name: 'bwrap',
        reason:
          `bare-metal scaler "${entry.name}" has KICI_SANDBOX=true configured. ` +
          `bubblewrap is required for namespace isolation. Install via ` +
          `'apt install bubblewrap' (Debian/Ubuntu) or 'dnf install bubblewrap' (Fedora/RHEL). ` +
          `bwrap is Linux-only — set KICI_SANDBOX=false on macOS/Windows hosts.`,
      });
    }

    return requirements;
  }

  get labelSets(): LabelSetConfig[] {
    return this._labelSets;
  }

  getActiveCount(): number {
    return this.agents.size;
  }

  async spawn(
    labelSet: string[],
    agentId: string,
    orchestratorUrl: string,
    onEvent?: ScalerEventCallback,
    effectiveLimits?: EffectiveLimits,
  ): Promise<ManagedAgent> {
    const emit = (eventType: Parameters<ScalerEventCallback>[0]['eventType'], detail: string) => {
      onEvent?.({ agentId, eventType, detail, timestampMs: Date.now() });
    };

    // Find matching label set config
    const normalizedTarget = normalizeLabelSet(labelSet);
    const matchedLabelSet = this._labelSets.find(
      (ls) => normalizeLabelSet(ls.labels) === normalizedTarget,
    );
    if (!matchedLabelSet) {
      throw new Error(
        `Label set [${labelSet.join(', ')}] not supported by bare-metal backend "${this.name}"`,
      );
    }

    // Check capacity
    if (this.getActiveCount() >= this.maxAgents) {
      throw new Error(
        `Bare-metal backend "${this.name}" at capacity (${this.maxAgents}/${this.maxAgents})`,
      );
    }

    emit(ScalerEventType.enum['scaler.provisioning'], 'spawning agent process');

    // Build sanitized env for agent process (no ...process.env spread!)
    const env: Record<string, string> = {};

    // 1. Allowlisted system vars from orchestrator process.env
    for (const key of ALLOWED_SYSTEM_VARS) {
      const value = process.env[key];
      if (value !== undefined) env[key] = value;
    }

    // 2. KICI_AGENT_ENV_ forwarded vars (prefix stripped)
    for (const [key, value] of Object.entries(process.env)) {
      if (key.startsWith(KICI_AGENT_ENV_PREFIX) && value !== undefined) {
        const strippedKey = key.slice(KICI_AGENT_ENV_PREFIX.length);
        if (strippedKey.length > 0) env[strippedKey] = value;
      }
    }

    // Full label set the agent will present (base + scaler-assigned kici:
    // labels). The ephemeral token is bound to exactly this set so register-
    // time labels pass the scope gate; the agent adds only self-reported
    // os/arch/host facts on top, which the gate exempts.
    const fullLabels = scalerAgentLabels(labelSet, this.type, this.name, this.roles);

    // 2.5. Create ephemeral agent token if token store is available
    if (this.tokenStore) {
      env.KICI_AGENT_TOKEN = await this.tokenStore.createEphemeral(
        agentId,
        fullLabels,
        this.tokenTtlMs,
      );
    }

    // 3. Required agent KICI_* vars (explicit values, not from process.env)
    env.KICI_ORCHESTRATOR_URL = orchestratorUrl;
    env.KICI_AGENT_ID = agentId;
    env.KICI_LABELS = fullLabels.join(',');
    env.KICI_SCALER_MANAGED = '1';
    env.KICI_EXECUTION_MODE = 'bare-metal';
    env.KICI_PORT = '0';

    // 3.5. Backpressure mode (before label-set env so explicit env: can override)
    if (matchedLabelSet.backpressureMode) {
      env.KICI_BACKPRESSURE_MODE = matchedLabelSet.backpressureMode;
    }

    // 4. Label-set env from scalers.yaml (highest priority, overrides KICI_AGENT_ENV_)
    Object.assign(env, matchedLabelSet.env ?? {});

    // Resolve cgroup wrapping: enforce only on Linux when enforceCgroups is true
    // and effectiveLimits has at least one positive field. Otherwise spawn the
    // binary directly (advisory limits — the scaler still tracks usage but the
    // kernel does not enforce the per-process cap).
    const { command, args } = this.buildSpawnInvocation(
      matchedLabelSet.binaryPath!,
      agentId,
      effectiveLimits,
    );

    // Spawn process in detached process group (Pitfall #4: process group isolation)
    const child = spawn(command, args, {
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env,
    });

    // Don't keep parent alive waiting for child
    child.unref();

    // Create log capture from child stdout/stderr merged into a single stream
    const merged = new PassThrough();
    child.stdout?.pipe(merged, { end: false });
    child.stderr?.pipe(merged, { end: false });

    // End the merged stream when the child process exits
    child.on('exit', () => {
      merged.end();
    });

    // Bounded ring buffer of the most recent output lines, kept so a spawn
    // that dies before WS registration can ride its stderr along in the
    // scaler.failed event detail.
    const TAIL_MAX_LINES = 50;
    const tailBuf: string[] = [];
    const pushTail = (line: string) => {
      tailBuf.push(line);
      if (tailBuf.length > TAIL_MAX_LINES) tailBuf.shift();
    };

    const rl = createInterface({ input: merged, crlfDelay: Infinity });
    rl.on('line', pushTail);
    const capture: LogCapture = {
      async *lines() {
        for await (const line of rl) {
          yield line;
        }
      },
      tail() {
        return tailBuf.join('\n');
      },
      close() {
        rl.close();
        merged.destroy();
      },
    };

    const managed: BareMetalManagedAgent = {
      id: agentId,
      labelSet,
      backendRef: String(child.pid),
      spawnedAt: Date.now(),
      state: 'running',
      process: child,
    };

    this.agents.set(managed.id, managed);
    this.logCaptures.set(managed.id, capture);

    emit(ScalerEventType.enum['scaler.ready'], `agent process started (PID ${child.pid})`);
    emit(ScalerEventType.enum['agent.connecting'], 'waiting for agent WS registration');

    // Emit failure event on spawn error (e.g. ENOENT for missing binary).
    // Also clean up tracking maps — when spawn fails, the 'exit' event may not fire.
    child.on('error', (err) => {
      const t = capture.tail();
      const detail = t
        ? `agent process error: ${err.message}\n--- captured output (last ${TAIL_MAX_LINES} lines) ---\n${t}`
        : `agent process error: ${err.message}`;
      emit(ScalerEventType.enum['scaler.failed'], detail);
      this.logCaptures.delete(managed.id);
      this.agents.delete(managed.id);
    });

    // Listen for exit event to auto-cleanup from tracking maps
    child.on('exit', () => {
      this.logCaptures.delete(managed.id);
      this.agents.delete(managed.id);
    });

    return managed;
  }

  getScalerContext(agentId: string): Record<string, unknown> | undefined {
    const managed = this.agents.get(agentId);
    if (!managed) return undefined;

    const normalizedTarget = normalizeLabelSet(managed.labelSet);
    const matchedLabelSet = this._labelSets.find(
      (ls) => normalizeLabelSet(ls.labels) === normalizedTarget,
    );

    return {
      backendType: 'bare-metal',
      scalerName: this.name,
      binaryPath: matchedLabelSet?.binaryPath,
      resources: matchedLabelSet?.resources ?? this.defaultResources,
    };
  }

  async destroy(managedId: string): Promise<void> {
    const managed = this.agents.get(managedId);
    if (!managed) return;

    managed.state = 'destroying';

    // Close log capture before killing the process
    const capture = this.logCaptures.get(managedId);
    if (capture) {
      capture.close();
      this.logCaptures.delete(managedId);
    }

    const pid = parseInt(managed.backendRef, 10);

    // Guard against NaN PID (happens when spawn fails before PID is assigned, e.g. ENOENT)
    if (isNaN(pid)) {
      this.agents.delete(managedId);
      return;
    }

    // Send SIGTERM to entire process group (negative PID kills group)
    try {
      process.kill(-pid, 'SIGTERM');
    } catch (err: unknown) {
      // ESRCH = no such process -- process already dead
      if ((err as NodeJS.ErrnoException).code === 'ESRCH') {
        this.agents.delete(managedId);
        return;
      }
      throw err;
    }

    // Wait up to 5 seconds for exit, then SIGKILL
    const exited = await this.waitForExit(managed, 5000);
    if (!exited) {
      try {
        process.kill(-pid, 'SIGKILL');
      } catch {
        // Process may have exited between check and kill
      }
    }

    this.agents.delete(managedId);
  }

  /**
   * Get the LogCapture for a managed agent (used by ScalerManager for log forwarding).
   */
  getLogCapture(managedId: string): LogCapture | undefined {
    return this.logCaptures.get(managedId);
  }

  async shutdownAll(): Promise<void> {
    const ids = [...this.agents.keys()];
    await Promise.allSettled(ids.map((id) => this.destroy(id)));
  }

  reload(labelSets: LabelSetConfig[]): ValidationResult {
    // Validate: all bare-metal label sets must have binaryPath
    const errors: string[] = [];
    labelSets.forEach((ls, i) => {
      if (!ls.binaryPath) {
        errors.push(`Label set [${i}] requires a 'binaryPath' field for bare-metal backend`);
      }
    });

    if (errors.length > 0) {
      return { valid: false, errors };
    }

    this._labelSets = labelSets;
    this.warnNetworkPolicy(labelSets, createLogger({ prefix: 'bare-metal-backend' }));
    return { valid: true };
  }

  /**
   * Build the (command, args) tuple used to spawn an agent process.
   *
   * Two modes:
   *   - Direct: returns (binaryPath, []) — the historical bare-metal flow.
   *     Used when enforceCgroups is false, the host is non-Linux, or the
   *     resolved limits carry no positive cpus/memBytes.
   *   - systemd-run scope: returns ('systemd-run', [...]) wrapping the
   *     binary in a transient `--user --scope --slice=kici-scaler` cgroup
   *     with `CPUQuota=` / `MemoryMax=` properties translated from the
   *     effective limits. The scope name embeds `agentId` so each agent is
   *     a separately-named transient unit (and `systemctl --user status
   *     kici-agent-<agentId>.scope` works).
   *
   * `CPUQuota` is expressed as a percent (1.0 cpus = 100%). `MemoryMax`
   * accepts a raw byte count.
   */
  private buildSpawnInvocation(
    binaryPath: string,
    agentId: string,
    effectiveLimits: EffectiveLimits | undefined,
  ): { command: string; args: string[] } {
    const cpus =
      typeof effectiveLimits?.cpus === 'number' && effectiveLimits.cpus > 0
        ? effectiveLimits.cpus
        : 0;
    const memBytes =
      typeof effectiveLimits?.memBytes === 'number' && effectiveLimits.memBytes > 0
        ? effectiveLimits.memBytes
        : 0;

    if (!this.enforceCgroups || process.platform !== 'linux' || (cpus === 0 && memBytes === 0)) {
      return { command: binaryPath, args: [] };
    }

    const args: string[] = [
      '--user',
      '--scope',
      '--quiet',
      '--slice=kici-scaler',
      `--unit=kici-agent-${agentId}`,
    ];
    if (cpus > 0) {
      const quotaPercent = Math.max(1, Math.round(cpus * 100));
      args.push(`--property=CPUQuota=${quotaPercent}%`);
    }
    if (memBytes > 0) {
      args.push(`--property=MemoryMax=${memBytes}`);
    }
    args.push(binaryPath);
    return { command: 'systemd-run', args };
  }

  /**
   * Wait for a process to exit within a timeout.
   * Returns true if the process exited, false if timed out.
   */
  private waitForExit(managed: BareMetalManagedAgent, timeoutMs: number): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        managed.process.removeListener('exit', onExit);
        resolve(false);
      }, timeoutMs);

      const onExit = () => {
        clearTimeout(timer);
        resolve(true);
      };

      // Check if already dead
      if (managed.process.exitCode !== null || managed.process.signalCode !== null) {
        clearTimeout(timer);
        resolve(true);
        return;
      }

      managed.process.once('exit', onExit);
    });
  }
}

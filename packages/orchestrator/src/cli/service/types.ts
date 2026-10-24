/**
 * The ServiceManager contract shared by every platform driver (systemd,
 * launchd, Windows Services, Docker/Podman Compose).
 */

export type ServicePlatform = 'systemd' | 'launchd' | 'windows' | 'compose';

/** Restart behavior on service failure. */
export interface RestartPolicy {
  enabled: boolean;
  /** Backoff delays in seconds between restart attempts. */
  delays: number[];
  /** Maximum consecutive failures before giving up. */
  maxRetries: number;
  /** Window in seconds for counting consecutive failures. */
  windowSeconds: number;
}

/** Default restart policy: backoff 1s, 5s, 15s, 30s; max 5 failures in 5 minutes. */
export const DEFAULT_RESTART_POLICY: RestartPolicy = {
  enabled: true,
  delays: [1, 5, 15, 30],
  maxRetries: 5,
  windowSeconds: 300,
};

/**
 * Shared by `install` and every re-registering upgrade, so an upgraded
 * registration carries the same text as a fresh one.
 */
export const SERVICE_TEXT: Record<
  'orchestrator' | 'agent',
  { displayName: string; description: string }
> = {
  orchestrator: {
    displayName: 'KiCI Orchestrator',
    description: 'KiCI CI/CD workflow orchestrator service',
  },
  agent: {
    displayName: 'KiCI Agent',
    description: 'KiCI CI/CD workflow execution agent service',
  },
};

export interface ServiceConfig {
  /** Service identifier (e.g., "kici-orchestrator"). */
  name: string;
  displayName: string;
  description: string;
  executablePath: string;
  /**
   * Arguments after {@link executablePath} in the unit's run command: the
   * resolved server script path for a Node-launched server
   * (e.g. `["/opt/kici/dist/server.js"]`), empty for a self-launching binary.
   */
  args?: string[];
  /**
   * Node bin dir to guarantee on the generated unit's PATH, because the
   * bare-metal scaler spawns the kici-agent node script. With an explicit
   * `--binary` wrapper, {@link executablePath} is the wrapper, so its dirname
   * is wrong; install sets this to `path.dirname(process.execPath)`. Lifecycle
   * commands that don't regenerate the unit leave it unset, and the generators
   * fall back to `dirname(executablePath)`.
   */
  nodeBinDir?: string;
  /** Path to the environment file (.env). */
  envFilePath: string;
  workingDirectory: string;
  /** Unix only. */
  user?: string;
  /** Whether this is a user-level (non-root) service. */
  isUserLevel: boolean;
  restartPolicy: RestartPolicy;
  /**
   * Embedded in the unit (X-KiCI-Component for systemd, KiCIComponent for
   * launchd, dev.kici.component label for compose, description prefix for
   * Windows) so `list()` classifies a unit without naming conventions.
   * Required on install; optional for ops that don't regenerate the unit.
   */
  component?: 'orchestrator' | 'agent';
  /**
   * The deploy folder holding this instance's manifest. Embedded in the unit
   * (X-KiCI-InstanceDir for systemd, KiCIInstanceDir for launchd,
   * dev.kici.instance-dir for compose, a description suffix for Windows) so
   * `list()` recovers it from the init system, making the instance index a
   * rebuildable cache rather than the sole name→folder mapping. Set on
   * install; optional for ops that don't regenerate the unit.
   */
  instanceDir?: string;
}

/**
 * The launch command an installed unit executes, parsed back out of the
 * unit/plist/service registration. For a Node-launched server `execPath` is
 * the node binary and `args` the resolved entry script path.
 */
export interface LaunchSpec {
  execPath: string;
  args: string[];
  /**
   * The account a system-level unit runs as (systemd `User=`, launchd
   * `UserName`), when it names one. A registration written again keeps it.
   */
  user?: string;
}

export type ServiceState = 'running' | 'stopped' | 'failed' | 'unknown';

export interface ServiceStatus {
  state: ServiceState;
  pid?: number;
  /** Seconds. */
  uptime?: number;
  /** ISO timestamp of the last start. */
  startedAt?: string;
}

export interface LogOptions {
  /** A duration (e.g., "1h", "30m"). */
  since?: string;
  level?: 'error' | 'warn' | 'info';
  /** Output as JSON lines. */
  json?: boolean;
  /** Tail -f mode. */
  follow?: boolean;
}

export interface DiscoveredInstance {
  name: string;
  platform: ServicePlatform;
  isUserLevel: boolean;
  /** Decoded from the unit's KiCI marker. */
  component: 'orchestrator' | 'agent';
  /**
   * From the unit's instance-dir marker. Undefined for units installed before
   * the marker existed; the index cache is their fallback.
   */
  instanceDir?: string;
}

export interface ServiceManager {
  /**
   * Discovery scans several drivers at once, and each scan is authoritative
   * only over its own platform's index rows, even when empty. An empty scan has
   * no row to read a platform off, so the driver states it here.
   */
  readonly platform: ServicePlatform;

  /**
   * Whether this driver can inspect its registry now. On `false` the driver is
   * excluded from discovery and its platform's index rows are left untouched:
   * an empty scan of an unreachable registry is not evidence the instances
   * are gone.
   *
   * Absent means always available. systemd and launchd omit it and let an
   * unreadable unit directory throw out of `list()`; compose and Windows
   * implement it because their registry is a service that can be down or hung
   * while the host and client binary are fine.
   *
   * An implementation MUST probe the registry itself, not its client:
   * `<runtime> compose version` and `where powershell` both answer while the
   * registry is down, which once reported available, scanned empty, and
   * pruned live rows.
   *
   * Discovery calls this INSIDE its own error handling, so a rejecting probe
   * drops only this driver.
   */
  available?(): Promise<boolean>;

  install(config: ServiceConfig): Promise<void>;

  /** Remove the service registration (preserves config/data). */
  uninstall(config: ServiceConfig): Promise<void>;

  start(config: ServiceConfig): Promise<void>;

  stop(config: ServiceConfig): Promise<void>;

  /** Stop + start. */
  restart(config: ServiceConfig): Promise<void>;

  status(config: ServiceConfig): Promise<ServiceStatus>;

  logs(config: ServiceConfig, options: LogOptions): Promise<void>;

  isInstalled(config: ServiceConfig): Promise<boolean>;

  /**
   * Enumerate KiCI-managed services in the native registry
   * (systemctl/launchctl/sc/podman), decoding each unit's component marker.
   * resolve.ts#listInstances reconciles the index cache against it.
   * `isUserLevel` selects scope on systemd and launchd; ignored elsewhere.
   *
   * An empty array means the registry answered with no KiCI services, and the
   * reconcile prunes this platform's index rows. A driver that could not read
   * its registry must throw rather than return `[]`; discovery drops a
   * throwing driver as it drops one whose `available()` said false.
   */
  list(isUserLevel: boolean): Promise<DiscoveredInstance[]>;

  /**
   * Parse the launch command from the init system's own record (systemd
   * ExecStart, launchd ProgramArguments, windows service binPath). Null when
   * the unit is not installed, its spec can't be parsed, or the platform has
   * no node-launched entry (compose). The npm-source upgrade verifies the
   * version that will run with it before reporting success.
   */
  readLaunchSpec(config: ServiceConfig): Promise<LaunchSpec | null>;
}

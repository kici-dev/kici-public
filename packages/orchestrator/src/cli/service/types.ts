/**
 * Shared types for the service management system.
 *
 * Defines the ServiceManager interface contract and supporting types
 * used by all platform-specific service managers (systemd, launchd,
 * Windows Services, Docker/Podman Compose).
 */

/** Supported service platforms. */
export type ServicePlatform = 'systemd' | 'launchd' | 'windows' | 'compose';

/** Restart behavior on service failure. */
export interface RestartPolicy {
  /** Whether to restart on failure. */
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

/** Configuration for installing a service. */
export interface ServiceConfig {
  /** Service identifier (e.g., "kici-orchestrator"). */
  name: string;
  /** Human-readable display name. */
  displayName: string;
  /** Service description. */
  description: string;
  /** Path to the executable binary. */
  executablePath: string;
  /**
   * Arguments passed to {@link executablePath} in the unit's run command.
   * For a Node-launched server this is the resolved server script path
   * (e.g. `["/opt/kici/dist/server.js"]`); empty for a self-launching binary.
   */
  args?: string[];
  /**
   * Node bin dir to guarantee on the generated unit's PATH.
   *
   * The bare-metal scaler spawns the kici-agent node script, so `node` must be
   * findable on the orchestrator's PATH. When the service is installed with an
   * explicit `--binary` (a wrapper script), {@link executablePath} points at the
   * wrapper, not node — so its dirname is the wrong directory. The install path
   * sets this to `path.dirname(process.execPath)` (the node actually running the
   * install command), which is the correct node bin dir regardless of `--binary`.
   * Optional: lifecycle commands that don't regenerate the unit leave it unset,
   * and the unit generators fall back to `dirname(executablePath)`.
   */
  nodeBinDir?: string;
  /** Path to the environment file (.env). */
  envFilePath: string;
  /** Working directory for the service process. */
  workingDirectory: string;
  /** User to run the service as (Unix only). */
  user?: string;
  /** Whether this is a user-level (non-root) service. */
  isUserLevel: boolean;
  /** Restart policy configuration. */
  restartPolicy: RestartPolicy;
  /**
   * Which KiCI component this service runs. Embedded in the unit (X-KiCI-Component
   * for systemd, KiCIComponent for launchd, dev.kici.component label for compose,
   * description prefix for Windows) so per-driver `list()` scans can classify
   * a discovered unit without relying on naming conventions.
   *
   * Optional during lifecycle ops that don't regenerate the unit; required on install.
   */
  component?: 'orchestrator' | 'agent';
  /**
   * The deploy folder that holds this instance's manifest. Embedded in the unit
   * (X-KiCI-InstanceDir for systemd, KiCIInstanceDir for launchd,
   * dev.kici.instance-dir for compose, a description suffix for Windows) so
   * per-driver `list()` scans can recover the deploy folder straight from the
   * init system — making the instance index a true rebuildable cache rather
   * than the sole source of the name→folder mapping.
   *
   * Optional during lifecycle ops that don't regenerate the unit; set on install.
   */
  instanceDir?: string;
}

/**
 * The launch command an installed init unit will actually execute, parsed
 * back out of the unit/plist/service registration. `execPath` is the binary
 * the init system runs (for a Node-launched server, the node binary); `args`
 * are everything after it (for a Node-launched server, the resolved entry
 * script path). Returned by {@link ServiceManager.readLaunchSpec}.
 */
export interface LaunchSpec {
  execPath: string;
  args: string[];
}

/** Current state of a service. */
export type ServiceState = 'running' | 'stopped' | 'failed' | 'unknown';

/** Runtime status information for a service. */
export interface ServiceStatus {
  /** Current service state. */
  state: ServiceState;
  /** Process ID if running. */
  pid?: number;
  /** Uptime in seconds if running. */
  uptime?: number;
  /** ISO timestamp when the service last started. */
  startedAt?: string;
}

/** Options for the logs command. */
export interface LogOptions {
  /** Show logs since this duration (e.g., "1h", "30m"). */
  since?: string;
  /** Filter by log level. */
  level?: 'error' | 'warn' | 'info';
  /** Output as JSON lines. */
  json?: boolean;
  /** Follow (tail -f) mode. */
  follow?: boolean;
}

/** Result of a per-driver discovery scan. */
export interface DiscoveredInstance {
  name: string;
  /** Always set; the driver knows its own platform. */
  platform: ServicePlatform;
  isUserLevel: boolean;
  /** The component this unit belongs to, decoded from the unit's KiCI marker. */
  component: 'orchestrator' | 'agent';
  /**
   * The deploy folder recovered from the unit's KiCI instance-dir marker, when
   * the unit carries one. Undefined for units installed before the marker
   * existed (the index cache remains the fallback for those).
   */
  instanceDir?: string;
}

/**
 * Interface that all platform-specific service managers must implement.
 *
 * Each method operates on a service identified by the ServiceConfig.
 */
export interface ServiceManager {
  /** Install and register the service with the init system. */
  install(config: ServiceConfig): Promise<void>;

  /** Remove the service registration (preserves config/data). */
  uninstall(config: ServiceConfig): Promise<void>;

  /** Start the service. */
  start(config: ServiceConfig): Promise<void>;

  /** Stop the service. */
  stop(config: ServiceConfig): Promise<void>;

  /** Restart the service (stop + start). */
  restart(config: ServiceConfig): Promise<void>;

  /** Get the current service status. */
  status(config: ServiceConfig): Promise<ServiceStatus>;

  /** Stream or display service logs. */
  logs(config: ServiceConfig, options: LogOptions): Promise<void>;

  /** Check if the service is currently installed/registered. */
  isInstalled(config: ServiceConfig): Promise<boolean>;

  /**
   * Discover KiCI-managed services on this platform. The driver enumerates
   * its native registry (systemctl/launchctl/sc/podman) and decodes each
   * unit's component marker. Used by resolve.ts#listInstances to reconcile
   * the index cache against ground truth.
   *
   * `isUserLevel` selects user vs system scope on platforms where that matters
   * (systemd, launchd); ignored on Windows/compose.
   */
  list(isUserLevel: boolean): Promise<DiscoveredInstance[]>;

  /**
   * Read the launch command the installed unit will actually execute, parsed
   * back out of the init system's own record (systemd ExecStart, launchd
   * ProgramArguments, windows service binPath). Returns null when the unit is
   * not installed, its launch spec can't be parsed, or the platform has no
   * node-launched entry to resolve (compose). Used by the npm-source upgrade to
   * verify the version that will run before reporting success.
   */
  readLaunchSpec(config: ServiceConfig): Promise<LaunchSpec | null>;
}

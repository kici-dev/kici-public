/**
 * Docker/Podman Compose service manager.
 *
 * Generates compose YAML files and manages service lifecycle via
 * `docker compose` or `podman compose` (auto-detected). Provides
 * a container-based service management backend that works on any
 * platform with Docker or Podman installed.
 */

import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { composeFilePath } from './compose-path.js';
import { resolveImageRef } from './image-digests.js';
import type {
  ServiceManager,
  ServiceConfig,
  ServiceStatus,
  LogOptions,
  ServiceState,
  DiscoveredInstance,
  LaunchSpec,
} from './types.js';

/** Container runtime binary (`podman` or `docker`); compose form is `${runtime} compose`. */
type Runtime = 'podman' | 'docker';

/**
 * How long a discovery probe may wait on the container runtime.
 *
 * Discovery runs on paths that have nothing to do with containers: every
 * lifecycle command resolving `--name`, and `install` deciding whether a
 * same-named instance already exists. A wedged container daemon must not hold
 * those commands open, so both probes are bounded and a probe that runs out of
 * time is read as "this runtime does not answer" — the same outcome as a host
 * with no runtime at all.
 *
 * Healthy cost of the two probes on a developer host is 0.22s (`compose
 * version`) and 0.40s (`ps -a`), so 10s is roughly 25x the slower one: wide
 * enough for a loaded host or a cold runtime start, short enough that a
 * `kici-admin` command against a hung daemon fails in seconds. `detectRuntime`
 * tries two runtimes in turn, so its worst case is twice this.
 *
 * SIGKILL rather than the default SIGTERM: a runtime client blocked on a socket
 * read is exactly the case that ignores a polite signal, and a probe that
 * "timed out" and then kept the command open would defeat the bound.
 */
const RUNTIME_PROBE_TIMEOUT_MS = 10_000;

/**
 * Detect which container runtime is available.
 * Tries podman compose first, then docker compose.
 *
 * Exported so the orchestrator installer can resolve the runtime once when
 * injecting the `KICI_DEPLOY_CONTAINER_RUNTIME` env var for a compose deploy.
 *
 * @throws When neither runtime is found.
 */
export function detectRuntime(): Runtime {
  try {
    execSync('podman compose version', {
      stdio: 'pipe',
      timeout: RUNTIME_PROBE_TIMEOUT_MS,
      killSignal: 'SIGKILL',
    });
    return 'podman';
  } catch {
    // podman not available, or it did not answer within the probe budget
  }

  try {
    execSync('docker compose version', {
      stdio: 'pipe',
      timeout: RUNTIME_PROBE_TIMEOUT_MS,
      killSignal: 'SIGKILL',
    });
    return 'docker';
  } catch {
    // docker not available, or it did not answer within the probe budget
  }

  throw new Error('No container runtime found. Install Docker or Podman with compose support.');
}

/**
 * Read a `ps` row's labels into a map, accepting either runtime's shape.
 *
 * `docker ps --format '{{json .}}'` renders labels as one comma-joined
 * `key=value` string; `podman ps` renders them as a JSON object. Measured on
 * podman 5.4.2 and docker 28.x against a container carrying
 * `dev.kici.component`:
 *
 *   podman -> "Labels":{"dev.kici.component":"orchestrator",...}
 *   docker -> "Labels":"dev.kici.component=orchestrator,..."
 *
 * Reading only the docker shape yields an empty label set on every podman host,
 * so every KiCI container is skipped and discovery reports "no compose
 * instances" — which the caller cannot tell apart from a host that genuinely
 * holds none.
 */
function parseContainerLabels(raw: unknown): Record<string, string> {
  const out: Record<string, string> = {};

  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
      if (typeof value === 'string') out[key] = value;
    }
    return out;
  }

  if (typeof raw !== 'string') return out;
  for (const pair of raw.split(',')) {
    const eq = pair.indexOf('=');
    if (eq <= 0) continue;
    out[pair.slice(0, eq).trim()] = pair.slice(eq + 1);
  }
  return out;
}

/**
 * Read a `ps` row's container name, accepting either runtime's shape.
 *
 * `podman ps` renders `Names` as an array (a container may carry several);
 * `docker ps` renders it as a single string. The compose installer names one
 * container per instance, so the first entry is the instance name.
 */
function parseContainerName(raw: unknown): string {
  if (typeof raw === 'string') return raw;
  if (Array.isArray(raw)) {
    const first = raw.find((n): n is string => typeof n === 'string' && n.length > 0);
    return first ?? '';
  }
  return '';
}

/**
 * Get the path to the compose file for a service.
 * Uses the directory of the env file (e.g., /etc/kici/) as the location.
 */
function getComposeFilePath(config: ServiceConfig): string {
  return composeFilePath(config.envFilePath, config.name);
}

/**
 * Map compose container state strings to our ServiceState type.
 */
function mapContainerState(state: string): ServiceState {
  const lower = state.toLowerCase();
  if (lower === 'running') return 'running';
  if (lower === 'exited' || lower === 'stopped' || lower === 'dead') return 'stopped';
  if (lower === 'restarting' || lower === 'created') return 'stopped';
  return 'unknown';
}

/**
 * Map restart policy to compose restart mode.
 */
function getRestartMode(config: ServiceConfig): string {
  if (!config.restartPolicy.enabled) return 'no';
  return 'unless-stopped';
}

/**
 * Seconds a runtime must wait after SIGTERM before it SIGKILLs the container.
 *
 * Compose defaults this to 10s, which is shorter than either component's own
 * graceful-shutdown budget, so a teardown that takes longer than 10s is killed
 * partway through: the orchestrator never broadcasts `peer.leaving` and never
 * closes its agent sockets, and the agent never finishes draining. That window
 * is reached exactly when it matters most — the orchestrator's scaler stops
 * each managed agent container with its own grace, so an orchestrator with
 * agents in flight routinely needs more than 10s.
 *
 * Each value is its component's force-exit budget plus headroom, so the
 * process always reaches its own timer first and the runtime's kill stays the
 * last resort it is meant to be:
 * - orchestrator: 30s (`setupGracefulShutdown` default) -> 45s
 * - agent: 10s plus a ~1s abort delay in its `onForceExit` -> 20s
 *
 * An unrecognised component gets the larger value: over-waiting costs a few
 * seconds on shutdown, under-waiting corrupts it.
 */
function stopGracePeriodSeconds(config: ServiceConfig): number {
  const component = config.component ?? (config.name === 'kici-agent' ? 'agent' : 'orchestrator');
  return component === 'agent' ? 20 : 45;
}

/**
 * Generate compose YAML content for a service.
 *
 * Uses a manual YAML builder to avoid adding a YAML library dependency.
 * The generated file includes the service definition with env_file,
 * restart policy, and volume mounts.
 *
 * The `image:` line is pinned by manifest-list digest via `resolveImageRef`
 * (`quay.io/kici-dev/<service-name>:<version>@sha256:<digest>`), falling back
 * to the mutable `:latest` tag only when no recorded digest ships with this
 * package. Source of truth for the publish targets:
 * packages/ci/src/publish-images.ts. See
 * .claude/rules/container-publish-registry.md — Quay is the sole registry for
 * public KiCI images we publish.
 */
function generateComposeYaml(config: ServiceConfig): string {
  const restartMode = getRestartMode(config);

  const lines = [
    '# Generated by KiCI service installer',
    `# Service: ${config.displayName}`,
    '',
    'services:',
    `  ${config.name}:`,
    `    image: ${resolveImageRef(config.name)}`,
    `    container_name: ${config.name}`,
    `    restart: ${restartMode}`,
    `    stop_grace_period: ${stopGracePeriodSeconds(config)}s`,
    '    env_file:',
    `      - ${config.envFilePath}`,
    '    volumes:',
    `      - ${config.workingDirectory}:${config.workingDirectory}`,
    '    network_mode: host',
  ];

  if (config.component) {
    // Marker decoded by list() so podman/docker ps can classify the container's component.
    lines.push('    labels:');
    lines.push(`      dev.kici.component: ${config.component}`);
    // Deploy-folder marker so list() can recover the instanceDir straight from
    // the container labels, making the instance index a rebuildable cache.
    if (config.instanceDir) {
      lines.push(`      dev.kici.instance-dir: "${config.instanceDir}"`);
    }
  }

  return lines.join('\n') + '\n';
}

export class ComposeServiceManager implements ServiceManager {
  readonly platform = 'compose' as const;

  private runtime: Runtime | null = null;

  /**
   * True when the container runtime's own registry answers. A host with
   * neither podman nor docker cannot hold a running compose install, and a
   * host whose runtime is momentarily down still holds its installs — so
   * discovery reads a `false` here as "do not touch this platform's index
   * rows" rather than as an empty scan.
   *
   * Both halves are needed, and the second is the one that costs something.
   * `<runtime> compose version` is answered by the compose client alone: with
   * dockerd stopped it still exits 0 (measured), so a client-only probe reports
   * available, `list()` then gets an error it cannot distinguish from an empty
   * registry, and the reconcile prunes live rows. The `RUNTIME_PROBE_TIMEOUT_MS`
   * bound does not cover this — the client answers instantly whether or not the
   * daemon is there, so there is nothing for a timeout to catch.
   *
   * `ps -q` is the cheapest question only the registry can answer (0.02s
   * docker / 0.07s podman on a healthy host), and it fails the same two ways
   * the scan itself would: non-zero for a daemon that is down, and a timeout
   * kill for one that is hung.
   */
  async available(): Promise<boolean> {
    try {
      const runtime = this.getRuntime();
      execSync(`${runtime} ps -q`, {
        stdio: 'pipe',
        timeout: RUNTIME_PROBE_TIMEOUT_MS,
        killSignal: 'SIGKILL',
      });
      return true;
    } catch {
      return false;
    }
  }

  /** Get the runtime binary (`podman` or `docker`), detecting it if not already done. */
  private getRuntime(): Runtime {
    if (!this.runtime) {
      this.runtime = detectRuntime();
    }
    return this.runtime;
  }

  /** Run a compose command for the given service config. */
  private runCompose(config: ServiceConfig, args: string): void {
    const runtime = this.getRuntime();
    const composeFile = getComposeFilePath(config);
    execSync(`${runtime} compose -f "${composeFile}" ${args}`, { stdio: 'pipe' });
  }

  async install(config: ServiceConfig): Promise<void> {
    // Detect runtime first (will throw if neither available)
    this.getRuntime();

    // Ensure compose file directory exists
    const composeFile = getComposeFilePath(config);
    const dir = path.dirname(composeFile);
    fs.mkdirSync(dir, { recursive: true });

    // Generate and write compose file
    const yaml = generateComposeYaml(config);
    fs.writeFileSync(composeFile, yaml, 'utf-8');
  }

  async uninstall(config: ServiceConfig): Promise<void> {
    // Stop containers
    try {
      this.runCompose(config, 'down');
    } catch {
      // May already be down
    }

    // Remove compose file
    const composeFile = getComposeFilePath(config);
    if (fs.existsSync(composeFile)) {
      fs.unlinkSync(composeFile);
    }
  }

  async start(config: ServiceConfig): Promise<void> {
    this.runCompose(config, 'up -d');
  }

  async stop(config: ServiceConfig): Promise<void> {
    this.runCompose(config, 'down');
  }

  async restart(config: ServiceConfig): Promise<void> {
    this.runCompose(config, 'restart');
  }

  async status(config: ServiceConfig): Promise<ServiceStatus> {
    try {
      const runtime = this.getRuntime();
      const composeFile = getComposeFilePath(config);
      const output = execSync(`${runtime} compose -f "${composeFile}" ps --format json`, {
        stdio: 'pipe',
      }).toString();

      // Parse JSON output - can be a single object or array of objects
      const data = JSON.parse(output);
      const container = Array.isArray(data) ? data[0] : data;

      if (!container) {
        return { state: 'stopped' };
      }

      const state = mapContainerState(container.State || '');
      return { state };
    } catch {
      return { state: 'unknown' };
    }
  }

  async logs(config: ServiceConfig, options: LogOptions): Promise<void> {
    const args = ['logs'];

    if (options.follow) {
      args.push('--follow');
    }

    if (options.since) {
      args.push(`--since ${options.since}`);
    }

    args.push(config.name);

    try {
      this.runCompose(config, args.join(' '));
    } catch (err) {
      console.error(`Failed to read compose logs: ${err}`);
    }
  }

  async isInstalled(config: ServiceConfig): Promise<boolean> {
    const composeFile = getComposeFilePath(config);
    return fs.existsSync(composeFile);
  }

  async list(isUserLevel: boolean): Promise<DiscoveredInstance[]> {
    // Reuse the existing runtime detection from install/uninstall. A missing
    // runtime (or a probe that throws partway through) means "no KiCI
    // containers discoverable" — return [] cleanly so the caller can move on.
    let runtime: Runtime;
    try {
      runtime = this.getRuntime();
    } catch {
      return [];
    }

    // A failed registry read is NOT an empty registry, and the reconcile in
    // `listInstances` cannot tell the two apart from a return value — an `[]`
    // there prunes every compose row on the host. So the failure is thrown,
    // and `scanDrivers` drops this driver from the scan exactly as it drops
    // one whose `available()` said false. `[]` from here therefore means one
    // thing only: the registry answered, and holds no KiCI containers.
    let raw: string;
    try {
      raw = execSync(`${runtime} ps -a --filter label=dev.kici.component --format '{{json .}}'`, {
        encoding: 'utf-8',
        timeout: RUNTIME_PROBE_TIMEOUT_MS,
        killSignal: 'SIGKILL',
      }).toString();
    } catch (err) {
      throw new Error(
        `could not read the ${runtime} container registry: ${err instanceof Error ? err.message : String(err)}`,
        { cause: err },
      );
    }

    const out: DiscoveredInstance[] = [];
    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let row: unknown;
      try {
        row = JSON.parse(trimmed);
      } catch {
        continue;
      }
      if (!row || typeof row !== 'object') continue;
      const r = row as { Names?: unknown; Labels?: unknown };
      const labels = parseContainerLabels(r.Labels);
      const component = labels['dev.kici.component'];
      if (component !== 'orchestrator' && component !== 'agent') continue;
      const name = parseContainerName(r.Names);
      if (!name) continue;
      out.push({
        name,
        platform: 'compose',
        isUserLevel,
        component,
        instanceDir: labels['dev.kici.instance-dir'],
      });
    }
    return out;
  }

  async readLaunchSpec(_config: ServiceConfig): Promise<LaunchSpec | null> {
    return null; // compose is image-tag pinned; npm-source upgrade not used here
  }
}

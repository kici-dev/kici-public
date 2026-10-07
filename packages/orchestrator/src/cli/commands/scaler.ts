/**
 * Scaler maintenance commands for kici-admin.
 *
 *   scaler orphans        List the live Firecracker VMs a node's running
 *                         orchestrator does not track and, with --stop, stop
 *                         them. Goes through the admin HTTP API; `--target`
 *                         reaches a worker through the coordinator.
 *   scaler reload         Re-read the scaler config on this orchestrator and
 *                         every peer it is connected to (admin HTTP API);
 *                         each one applies its file completely or not at all.
 *   scaler reap-orphans   Free leaked Firecracker/container resources WITHOUT a
 *                         running orchestrator (recovery for a wedged node whose
 *                         data disk is full).
 *
 * `reap-orphans` loads the orchestrator's LOCAL config (no HTTP admin API, no
 * DB) and runs the liveness-driven reaper, which spares every live VM. It is the sanctioned operator path for
 * the ENOSPC bootstrap deadlock: when the data disk is 100% full the
 * orchestrator crash-loops before its in-process orphan sweep can run, so a
 * tool that frees disk WITHOUT the orchestrator is required.
 */
import type { Command } from 'commander';
import { loadLocalConfig } from '../../config/loader.js';
import { loadScalerConfig } from '../../scaler/config.js';
import { reapAllOrphans } from '../../scaler/reap-orphans.js';
import { ORCHESTRATOR_DEFAULT_PORT } from '@kici-dev/shared/env';
import { runIdempotentStep } from '@kici-dev/shared/idempotency';
import {
  ScalerReloadOutcome,
  ScalerVmStatus,
  ScalerVmStopOutcome,
  type ScalerLiveVm,
  type ScalerReloadInstanceResult,
} from '@kici-dev/engine';
import type {
  AdminApiClient,
  ScalerOrphansNode,
  ScalerOrphansStopResponse,
} from '../api-client.js';
import { confirmPrompt } from './shared/confirm.js';
import { MAX_SCALER_ORPHANS_TIMEOUT_MS } from '../../scaler/orphan-requests.js';
import { cliAction } from './shared/cli-action.js';

/** Probe the local orchestrator /health endpoint. Healthy => it reaps itself. */
export async function isOrchestratorHealthy(port: number, basePath: string): Promise<boolean> {
  const prefix = basePath === '/' ? '' : basePath.replace(/\/$/, '');
  const url = `http://127.0.0.1:${port}${prefix}/health`;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(2000) });
    return res.status === 200;
  } catch {
    return false;
  }
}

/** The `scaler orphans` options as Commander parses them. */
export interface ScalerOrphansOptions {
  target?: string;
  all: boolean;
  stop: boolean;
  vm: string[];
  yes: boolean;
  dryRun: boolean;
  /** Seconds to wait for a `--target` node. */
  timeout: string;
  json: boolean;
}

/** Where `scaler orphans` reads its confirmation and writes its output. */
export interface ScalerOrphansIo {
  confirm: (prompt: string) => Promise<boolean>;
  /** The listing, the results, or the JSON body. */
  out: (line: string) => void;
  /** Progress and the confirmation context; stderr, so `--json` output stays parseable. */
  err: (line: string) => void;
}

type OrphansClient = Pick<AdminApiClient, 'listScalerOrphans' | 'stopScalerOrphans'>;

/** `45s`, `12m3s`, `1h2m`, `3d4h`. */
export function formatAge(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  if (s < 60) return `${s}s`;
  if (s < 3_600) return `${Math.floor(s / 60)}m${s % 60}s`;
  if (s < 86_400) return `${Math.floor(s / 3_600)}h${Math.floor((s % 3_600) / 60)}m`;
  return `${Math.floor(s / 86_400)}d${Math.floor((s % 86_400) / 3_600)}h`;
}

function renderVmTable(vms: ScalerLiveVm[]): string {
  const headers = ['VM ID', 'SCALER', 'PID', 'AGE', 'STATUS', 'CHROOT', 'WHY'];
  const rows = vms.map((vm) => [
    vm.vmId,
    vm.scaler,
    String(vm.pid),
    formatAge(vm.ageSeconds),
    vm.status,
    vm.chrootDir,
    vm.reason,
  ]);
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i]!.length)));
  const line = (cells: string[]) =>
    cells
      .map((cell, i) => cell.padEnd(widths[i]!))
      .join('  ')
      .trimEnd();
  return [line(headers), ...rows.map(line)].join('\n');
}

/** Name the unreachable coordinator peers that keep every VM from being an orphan. */
function warnMissingCoordinators(node: ScalerOrphansNode, write: (line: string) => void): void {
  const missing = node.disconnectedCoordinators ?? [];
  if (missing.length === 0) return;
  write(
    `Coordinator peer(s) not connected: ${missing.join(', ')}. No VM is listed as orphaned ` +
      'until they reconnect: an agent registered with them cannot be ruled out.',
  );
}

function parseTimeoutMs(timeout: string): number {
  const seconds = Number(timeout);
  const max = MAX_SCALER_ORPHANS_TIMEOUT_MS / 1_000;
  if (!Number.isInteger(seconds) || seconds < 1 || seconds > max) {
    throw new Error(
      `--timeout must be a whole number of seconds from 1 to ${max}, got "${timeout}"`,
    );
  }
  return seconds * 1_000;
}

/** List the node's live VMs: orphaned and unverified ones, every one with `--all`. */
async function listOrphans(
  client: OrphansClient,
  opts: ScalerOrphansOptions,
  timeoutMs: number,
  io: ScalerOrphansIo,
): Promise<number> {
  const body = await client.listScalerOrphans({
    ...(opts.target !== undefined ? { target: opts.target } : {}),
    timeoutMs,
  });
  if (opts.json) {
    io.out(JSON.stringify(body, null, 2));
    return 0;
  }
  const shown = opts.all
    ? body.vms
    : body.vms.filter((vm) => vm.status !== ScalerVmStatus.enum.tracked);
  const where = `${body.node.instanceId} (${body.node.role})`;
  warnMissingCoordinators(body.node, io.out);
  if (shown.length === 0) {
    io.out(
      opts.all
        ? `No live Firecracker VMs on ${where}.`
        : `No orphaned or unverified VMs on ${where}.`,
    );
    return 0;
  }
  io.out(`Live Firecracker VMs on ${where}:`);
  io.out(renderVmTable(shown));
  return 0;
}

/** The orphaned VMs a stop would send, and the `--vm` ids it will not send, with why. */
function selectStop(
  vms: ScalerLiveVm[],
  wanted: string[],
): { send: ScalerLiveVm[]; notSent: Array<{ vmId: string; reason: string }> } {
  const orphaned = vms.filter((vm) => vm.status === ScalerVmStatus.enum.orphaned);
  if (wanted.length === 0) return { send: orphaned, notSent: [] };
  const byId = new Map(vms.map((vm) => [vm.vmId, vm]));
  const send: ScalerLiveVm[] = [];
  const notSent: Array<{ vmId: string; reason: string }> = [];
  for (const vmId of new Set(wanted)) {
    const vm = byId.get(vmId);
    if (!vm) notSent.push({ vmId, reason: 'not a live Firecracker VM on this node' });
    else if (vm.status !== ScalerVmStatus.enum.orphaned) {
      notSent.push({ vmId, reason: `not an orphan (${vm.reason})` });
    } else send.push(vm);
  }
  return { send, notSent };
}

/**
 * Stop the node's orphaned VMs behind check / prompt / apply. The VMs sent are
 * exactly the orphaned ones the check showed; an unverified VM is listed and
 * never sent, and the set is not recomputed after the confirmation.
 */
async function stopOrphans(
  client: OrphansClient,
  opts: ScalerOrphansOptions,
  timeoutMs: number,
  io: ScalerOrphansIo,
): Promise<number> {
  const target = opts.target !== undefined ? { target: opts.target } : {};
  let node: ScalerOrphansNode | undefined;
  let notSent: Array<{ vmId: string; reason: string }> = [];
  const step = await runIdempotentStep<ScalerLiveVm[], void, ScalerOrphansStopResponse>(
    {
      name: 'scaler/orphans/stop',
      check: async () => {
        const body = await client.listScalerOrphans({ ...target, timeoutMs });
        node = body.node;
        warnMissingCoordinators(body.node, io.err);
        const selected = selectStop(body.vms, opts.vm);
        notSent = selected.notSent;
        for (const skipped of notSent) io.err(`${skipped.vmId}: ${skipped.reason}`);
        return selected.send.length > 0 ? selected.send : null;
      },
      summarize: (send) =>
        `${renderVmTable(send)}\nStop ${send.length} VM(s) on ${node!.instanceId}`,
      apply: (send) =>
        client.stopScalerOrphans({ ...target, vmIds: send.map((vm) => vm.vmId), timeoutMs }),
    },
    {
      confirm: () => io.confirm(`Stop these VMs on ${node!.instanceId}? [y/N] `),
      yes: opts.yes,
      dryRun: opts.dryRun,
      log: io.err,
    },
  );

  if (step.outcome !== 'applied') {
    if (step.outcome === 'skipped') io.err(`No orphaned VMs on ${node!.instanceId}.`);
    if (opts.json) io.out(JSON.stringify({ node, outcome: step.outcome, results: [], notSent }));
    // A --vm id the node never got to stop is a VM this run did not reclaim.
    return step.outcome === 'skipped' && notSent.length > 0 ? 1 : 0;
  }
  const { results } = step.result;
  if (opts.json) {
    io.out(JSON.stringify({ node: step.result.node, outcome: step.outcome, results, notSent }));
  } else {
    for (const result of results) {
      const pid = result.pid !== undefined ? ` (PID ${result.pid})` : '';
      io.out(`${result.vmId}${pid}: ${result.outcome} — ${result.detail}`);
    }
  }
  // A script must see a VM it did not reclaim, a `--vm` id it never sent included.
  const allStopped = results.every((result) => result.outcome === ScalerVmStopOutcome.enum.stopped);
  return allStopped && notSent.length === 0 ? 0 : 1;
}

/**
 * `kici-admin scaler orphans`: list the live Firecracker VMs a node's
 * orchestrator does not track, and with `--stop` stop the orphaned ones.
 *
 * @returns the process exit code
 */
export async function runScalerOrphans(
  client: OrphansClient,
  opts: ScalerOrphansOptions,
  io: ScalerOrphansIo,
): Promise<number> {
  if (!opts.stop && (opts.vm.length > 0 || opts.yes || opts.dryRun)) {
    throw new Error('--vm, --yes and --dry-run apply to --stop only');
  }
  const timeoutMs = parseTimeoutMs(opts.timeout);
  return opts.stop
    ? stopOrphans(client, opts, timeoutMs, io)
    : listOrphans(client, opts, timeoutMs, io);
}

function collectVm(value: string, previous: string[]): string[] {
  return [...previous, value];
}

/** Register `scaler orphans` (admin HTTP API) on the `scaler` group. */
function registerOrphansCommand(scaler: Command, getClient: () => AdminApiClient): void {
  scaler
    .command('orphans')
    .description(
      'List live Firecracker VMs the orchestrator does not track, and stop them with --stop',
    )
    .option('--target <instance-id>', 'Node to inspect (default: the orchestrator --url points at)')
    .option('--all', 'Also list the VMs the orchestrator tracks', false)
    .option('--stop', 'Stop the orphaned VMs after a confirmation', false)
    .option('--vm <id>', 'With --stop: stop only this VM (repeatable)', collectVm, [])
    .option('--yes', 'With --stop: skip the confirmation prompt', false)
    .option('--dry-run', 'With --stop: show what would be stopped and stop nothing', false)
    .option('--timeout <seconds>', 'How long to wait for a --target node to answer', '30')
    .option('--json', 'Emit machine-readable JSON', false)
    .action(
      cliAction(async (opts: ScalerOrphansOptions) => {
        process.exitCode = await runScalerOrphans(getClient(), opts, {
          confirm: (prompt) => confirmPrompt(prompt),
          out: (line) => console.log(line),
          err: (line) => console.error(line),
        });
      }),
    );
}

export interface ScalerReloadOptions {
  single: boolean;
  timeout: string;
  json: boolean;
}

/** Outcomes that fail the command: a refused file, or an instance not reached. */
const FAILED_RELOAD_OUTCOMES: ReadonlySet<ScalerReloadOutcome> = new Set([
  ScalerReloadOutcome.enum.rejected,
  ScalerReloadOutcome.enum.unreachable,
]);

/** One block per instance: what changed, why the file was refused, or why there is no answer. */
function formatScalerReload(results: ScalerReloadInstanceResult[]): string {
  const lines: string[] = [];
  for (const r of results) {
    lines.push(`${r.instanceId} (${r.role}): ${r.outcome}`);
    if (r.plan) {
      for (const bucket of ['added', 'updated', 'retired', 'resurrected', 'global'] as const) {
        if (r.plan[bucket].length > 0) lines.push(`  ${bucket}: ${r.plan[bucket].join(', ')}`);
      }
      lines.push(`  unchanged: ${r.plan.unchanged.length}`);
    }
    for (const error of r.errors ?? []) lines.push(`  error: ${error}`);
    if (r.detail) lines.push(`  ${r.detail}`);
  }
  return lines.join('\n');
}

/**
 * `scaler reload`: reload the scaler config and print one block per instance.
 * Resolves the exit code: 1 when any instance refused its file or was not
 * reached, else 0. A bad `--timeout` throws before any request.
 */
export async function runScalerReload(
  client: Pick<AdminApiClient, 'scalerReload'>,
  opts: ScalerReloadOptions,
  out: (line: string) => void,
): Promise<number> {
  const timeoutMs = parseTimeoutMs(opts.timeout);
  const body = await client.scalerReload({ ...(opts.single ? { single: true } : {}), timeoutMs });
  out(opts.json ? JSON.stringify(body, null, 2) : formatScalerReload(body.results));
  return body.results.some((r) => FAILED_RELOAD_OUTCOMES.has(r.outcome)) ? 1 : 0;
}

/** Register `scaler reload` (admin HTTP API) on the `scaler` group. */
function registerReloadCommand(scaler: Command, getClient: () => AdminApiClient): void {
  scaler
    .command('reload')
    .description(
      'Re-read the scaler config on this orchestrator and every orchestrator it is ' +
        'connected to, and apply each file completely or not at all',
    )
    .option('--single', 'Reload only the orchestrator --url points at', false)
    .option('--timeout <seconds>', 'How long to wait for each peer to answer', '60')
    .option('--json', 'Emit machine-readable JSON', false)
    .action(
      cliAction(async (opts: ScalerReloadOptions) => {
        process.exitCode = await runScalerReload(getClient(), opts, (line) => console.log(line));
      }),
    );
}

export function registerScalerCommands(program: Command, getClient: () => AdminApiClient): void {
  const scaler = program.command('scaler').description('Scaler maintenance');

  registerOrphansCommand(scaler, getClient);
  registerReloadCommand(scaler, getClient);

  scaler
    .command('reap-orphans')
    .description('Free leaked Firecracker/container resources without a running orchestrator')
    .option(
      '--config <path>',
      'Path to the orchestrator config (default: KICI_CONFIG or /etc/kici/orchestrator.yaml)',
    )
    .option('--force', 'Reap even if the local orchestrator reports healthy', false)
    .option('--json', 'Emit machine-readable JSON counts', false)
    .action(
      cliAction(async (opts: { config?: string; force: boolean; json: boolean }) => {
        const local = await loadLocalConfig(opts.config);
        // Resolve the scaler config path from the same sources the orchestrator
        // itself uses: the local YAML's scaler.configPath, or the env var that
        // env-only workers (the rootless edge peers this command recovers) set.
        const scalerConfigPath = local.scaler?.configPath ?? process.env.KICI_SCALER_CONFIG_PATH;
        const scalerConfigDir = local.scaler?.configDir ?? process.env.KICI_SCALER_CONFIG_DIR;
        if (!scalerConfigPath) {
          console.error(
            'Error: no scaler config path found (set scaler.configPath in the orchestrator ' +
              'config, KICI_SCALER_CONFIG_PATH in the environment, or pass --config)',
          );
          process.exit(1);
        }
        const scalerConfig = await loadScalerConfig(scalerConfigPath, scalerConfigDir);

        const port =
          local.server?.port ?? Number(process.env.KICI_PORT ?? ORCHESTRATOR_DEFAULT_PORT);
        const basePath = local.server?.basePath ?? process.env.KICI_BASE_PATH ?? '/';
        const healthy = opts.force ? false : await isOrchestratorHealthy(port, basePath);

        if (healthy && !opts.force) {
          const msg = 'orchestrator is up and reaps orphans itself; pass --force to reap anyway';
          if (opts.json) {
            console.log(
              JSON.stringify({ skipped: true, reason: 'orchestrator-healthy', counts: {} }),
            );
          } else {
            console.log(msg);
          }
          process.exit(0);
        }

        // Orchestrator is down/wedged (or --force): FC reap is liveness-driven
        // (safe); container reap is unconditional but safe because the
        // orchestrator is not running.
        const counts = await reapAllOrphans({ scalerConfig, includeContainers: true });
        const total = Object.values(counts).reduce((a, b) => a + b, 0);

        if (opts.json) {
          console.log(JSON.stringify({ skipped: false, counts, total }));
        } else if (total === 0) {
          console.log('No orphan resources found.');
        } else {
          console.log(`Reaped ${total} orphan resource(s):`);
          for (const [name, n] of Object.entries(counts)) console.log(`  ${name}: ${n}`);
        }
      }),
    );
}

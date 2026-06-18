/**
 * Debug bundle CLI command for kici-admin.
 *
 * Creates a sanitized diagnostic ZIP bundle by calling multiple admin API
 * endpoints and assembling the results client-side. The bundle contains
 * config, diagnostics, system info, and cluster state for troubleshooting.
 *
 * Usage: kici-admin debug-bundle [--output <path>]
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Command } from 'commander';
import { ZipArchive } from 'archiver';
import type { AdminApiClient, FleetTopologyResponse } from '../api-client.js';
import { toErrorMessage, addLogsToArchive } from '@kici-dev/shared';

interface DebugBundleOptions {
  output: string;
  logDir?: string;
  logWindow: number;
  fleet?: boolean;
  list?: boolean;
  json?: boolean;
  pick?: string | boolean;
  fleetTimeout: number;
}

/**
 * Register the debug-bundle command on the CLI program.
 */
export function registerDebugBundleCommand(
  program: Command,
  getClient: () => AdminApiClient,
): void {
  program
    .command('debug-bundle')
    .description('Generate a diagnostic debug bundle ZIP for troubleshooting')
    .option(
      '-o, --output <path>',
      'Output ZIP file path',
      `kici-debug-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}.zip`,
    )
    .option(
      '--log-dir <path>',
      'Directory with rotated *.log files to include (defaults to $KICI_LOG_DIR)',
    )
    .option(
      '--log-window <hours>',
      'Hours of log history to include in the bundle',
      (value) => parseInt(value, 10),
      4,
    )
    .option('--fleet', 'Collect logs from every node in the cluster (server-side fan-out)')
    .option('--list', 'With --fleet: print the fleet topology and exit (no collection)')
    .option('--json', 'With --fleet --list: emit the topology as JSON')
    .option(
      '--pick [selectors]',
      'With --fleet: comma-separated selectors (id/host*/label:k=v); bare flag opens an interactive picker on a TTY',
    )
    .option(
      '--fleet-timeout <seconds>',
      'Per-node deadline for --fleet',
      (value) => parseInt(value, 10),
      60,
    )
    .action(async (opts: DebugBundleOptions) => {
      try {
        const client = getClient();
        if (opts.fleet) {
          await runFleetBundle(client, opts);
          return;
        }
        const outputPath = path.resolve(opts.output);

        console.log('Collecting diagnostic data...');

        // Gather data from admin API endpoints in parallel
        const [diagnoseResult, configResult, systemInfo, clusterHealth, metrics] =
          await Promise.allSettled([
            client.diagnose(),
            safeRequest(() => client.configExport()),
            safeRequest(() => client.get<Record<string, unknown>>('/admin/system-info')),
            safeRequest(() => client.get<Record<string, unknown>>('/cluster/health')),
            safeRequest(() => client.getText('/metrics')),
          ]);

        // Create the ZIP bundle
        const output = fs.createWriteStream(outputPath);
        const archive = new ZipArchive({ zlib: { level: 6 } });

        const finalized = new Promise<void>((resolve, reject) => {
          output.on('close', resolve);
          archive.on('error', reject);
        });

        archive.pipe(output);

        // Manifest
        const manifest = {
          version: '1.0',
          generated_at: new Date().toISOString(),
          source: 'kici-admin debug-bundle',
          node_version: process.version,
          platform: process.platform,
        };
        archive.append(JSON.stringify(manifest, null, 2), { name: 'manifest.json' });

        // Diagnostics
        if (diagnoseResult.status === 'fulfilled') {
          archive.append(JSON.stringify(diagnoseResult.value, null, 2), {
            name: 'diagnostics/results.json',
          });
        }

        // Config (already redacted server-side by config export)
        if (configResult.status === 'fulfilled' && configResult.value) {
          archive.append(JSON.stringify(configResult.value, null, 2), {
            name: 'config/config.json',
          });
        }

        // System info
        if (systemInfo.status === 'fulfilled' && systemInfo.value) {
          archive.append(JSON.stringify(systemInfo.value, null, 2), {
            name: 'system/info.json',
          });
        }

        // Cluster health
        if (clusterHealth.status === 'fulfilled' && clusterHealth.value) {
          archive.append(JSON.stringify(clusterHealth.value, null, 2), {
            name: 'cluster/health.json',
          });
        }

        // Metrics
        if (metrics.status === 'fulfilled' && metrics.value) {
          archive.append(String(metrics.value), { name: 'system/metrics.txt' });
        }

        // Logs — include rotated *.log files from the orchestrator's KICI_LOG_DIR
        // (same directory used by the shared Winston rotated-file transport).
        // Runs locally: the CLI is executed on the same host as the service,
        // so the files on disk are the ones we want to ship to support.
        const logDir = opts.logDir ?? process.env.KICI_LOG_DIR;
        if (logDir && fs.existsSync(logDir)) {
          await addLogsToArchive(archive, logDir, opts.logWindow);
        } else if (logDir) {
          console.warn(`Log dir ${logDir} does not exist — skipping logs/`);
        }

        await archive.finalize();
        await finalized;

        const stat = fs.statSync(outputPath);
        const sizeKB = (stat.size / 1024).toFixed(1);
        console.log(`Debug bundle saved to ${outputPath} (${sizeKB} KB)`);
      } catch (err) {
        console.error(`Error: ${toErrorMessage(err)}`);
        process.exit(1);
      }
    });
}

/**
 * Wrap an async call to return null on failure instead of throwing.
 */
async function safeRequest<T>(fn: () => Promise<T>): Promise<T | null> {
  try {
    return await fn();
  } catch {
    return null;
  }
}

/**
 * Fleet mode: enumerate (`--list`), pick nodes (`--pick`), or collect the whole
 * cluster into one nested ZIP via the orchestrator's server-side fan-out.
 */
async function runFleetBundle(client: AdminApiClient, opts: DebugBundleOptions): Promise<void> {
  // --list: enumerate the topology and exit, no collection.
  if (opts.list) {
    const topology = await client.getFleetTopology();
    if (opts.json) {
      console.log(JSON.stringify(topology, null, 2));
    } else {
      printTopologyTable(topology);
    }
    return;
  }

  const selectors = await resolveFleetSelectors(client, opts);
  const outputPath = path.resolve(opts.output);
  console.log('Collecting fleet bundle (this fans out to every selected node)...');
  await client.downloadFleetBundle(
    { selectors, logWindowHours: opts.logWindow, timeoutSeconds: opts.fleetTimeout },
    outputPath,
  );
  const stat = fs.statSync(outputPath);
  console.log(`Fleet bundle written to ${outputPath} (${(stat.size / 1024).toFixed(1)} KB)`);
}

/**
 * Resolve the `--pick` selectors: a bare `--pick` on a TTY opens an interactive
 * checkbox over the enumerated topology; a value is split on commas; no flag
 * means "everything".
 */
async function resolveFleetSelectors(
  client: AdminApiClient,
  opts: DebugBundleOptions,
): Promise<string[]> {
  if (opts.pick === undefined) return [];
  if (typeof opts.pick === 'string') {
    return opts.pick
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
  }
  // Bare --pick: interactive picker on a TTY.
  if (!process.stdout.isTTY) {
    throw new Error('--pick with no value requires a TTY; pass comma-separated selectors instead');
  }
  const { checkbox } = await import('@inquirer/prompts');
  const topology = await client.getFleetTopology();
  const choices = topology.nodes.map((n) => ({
    name: `${n.kind === 'orchestrator' ? `[${n.role ?? 'orchestrator'}]` : '  agent'} ${n.id}${
      n.hostname ? ` @ ${n.hostname}` : ''
    }`,
    value: n.id,
  }));
  return checkbox({ message: 'Select nodes to collect', choices });
}

/** Print the fleet topology as an indented tree (orchestrators with their agents). */
function printTopologyTable(topology: FleetTopologyResponse): void {
  const orchestrators = topology.nodes.filter((n) => n.kind === 'orchestrator');
  console.log(`Fleet topology (${topology.nodes.length} node(s)):`);
  for (const o of orchestrators) {
    const root = o.parentId === null ? ' (collector)' : '';
    console.log(
      `  [${o.role ?? 'orchestrator'}] ${o.id}${o.hostname ? ` @ ${o.hostname}` : ''}${root}`,
    );
    const agents = topology.nodes.filter((n) => n.kind === 'agent' && n.parentId === o.id);
    for (const a of agents) {
      console.log(`      agent ${a.id}`);
    }
  }
}

#!/usr/bin/env node

/**
 * Hetzner Cloud reaper for KiCI's workflow-driven autoscaling — the host-side
 * teardown backstop.
 *
 * Deletes every server that carries the managed label and is older than a TTL.
 * Run it from a timer every few minutes, on a host that is not one of the
 * servers it reaps. It depends only on the Hetzner API and the clock, so it
 * still cleans up after a crashed orchestrator, a killed run or a reboot — the
 * cases the teardown workflow cannot cover. A server that is already gone
 * counts as deleted.
 *
 * Copy this file and `hetzner-client.ts` into one directory and run it with
 * Node 22.18 or later. Node runs the TypeScript directly, so nothing needs
 * installing:
 *
 *   HCLOUD_TOKEN=<token> node reap.ts
 *
 * Environment:
 *   HCLOUD_TOKEN                      Hetzner Cloud API token (required)
 *   HCLOUD_ENDPOINT                   API base URL (default https://api.hetzner.cloud/v1)
 *   KICI_HETZNER_MANAGED_LABEL        label of managed servers (default kici-managed=hetzner-autoscale)
 *   KICI_HETZNER_REAP_TTL_MIN         delete servers older than this many minutes (default 30)
 *   KICI_HETZNER_SWEEP_WHOLE_PROJECT  `1` deletes EVERY server older than the TTL,
 *                                     labelled or not — only for a project that
 *                                     holds nothing but these servers
 *   KICI_HETZNER_REAP_METRIC_FILE     write a Prometheus textfile metric to this path
 */

import { realpathSync, renameSync, writeFileSync } from 'node:fs';
import { HetznerClient, type HetznerServer } from './hetzner-client.ts';

/**
 * Render the Prometheus textfile-collector body for one run: how many servers
 * it deleted, and how many deletes Hetzner refused. A deletion means the
 * teardown workflow and the in-instance poweroff both missed a server; a
 * failure means a leaked server is still running.
 *
 * Both are gauges, not counters: each run overwrites the file with its own
 * counts, so a steady leak reads 1, 1, 1 and never increases. Alert with
 * `max_over_time(kici_hetzner_reaper_last_run_deleted[1h]) > 0` and the same
 * over `_failed`, which stay firing for as long as any run in the window
 * deleted, or failed to delete, something.
 */
export function renderReaperMetric(deleted: number, failed: number): string {
  return (
    '# HELP kici_hetzner_reaper_last_run_deleted Servers the most recent Hetzner reaper run deleted.\n' +
    '# TYPE kici_hetzner_reaper_last_run_deleted gauge\n' +
    `kici_hetzner_reaper_last_run_deleted ${deleted}\n` +
    '# HELP kici_hetzner_reaper_last_run_failed Deletes the most recent Hetzner reaper run could not complete.\n' +
    '# TYPE kici_hetzner_reaper_last_run_failed gauge\n' +
    `kici_hetzner_reaper_last_run_failed ${failed}\n`
  );
}

/** A server the reaper tried and failed to delete. */
export interface ReapFailure {
  id: number;
  name: string;
  error: string;
}

/** What one reaper run did: the servers it deleted, and the deletes that failed. */
export interface ReapResult {
  deleted: number;
  failed: ReapFailure[];
}

/** The subset of the Hetzner client the reaper needs (so tests can mock it). */
export interface ReapableClient {
  listByLabel(selector?: string): Promise<HetznerServer[]>;
  deleteServer(id: number): Promise<void>;
}

export interface ReapOptions {
  /** Hetzner `label_selector` for the managed set, e.g. `kici-managed==hetzner-autoscale`. */
  managedLabel: string;
  /** Delete servers older than this many milliseconds. */
  olderThanMs: number;
  /** Injected clock (epoch ms) — no ambient Date.now() in the testable core. */
  now: () => number;
  /** Delete EVERY server older than the TTL, not only label-matched (dedicated project only). */
  sweepWholeProject?: boolean;
}

// #region reap
/**
 * Delete servers older than the TTL. A delete 404 (already gone) counts as a
 * success. A delete that fails is recorded and the run moves on, so one server
 * Hetzner refuses to delete never shields the servers listed after it.
 */
export async function reap(client: ReapableClient, opts: ReapOptions): Promise<ReapResult> {
  // An empty selector lists every server in the project, so only an explicit
  // whole-project sweep may send one.
  if (!opts.sweepWholeProject && opts.managedLabel.trim() === '') {
    throw new Error('reap: managedLabel is empty; set sweepWholeProject to sweep every server');
  }
  const selector = opts.sweepWholeProject ? '' : opts.managedLabel;
  const servers = await client.listByLabel(selector);
  const cutoff = opts.now() - opts.olderThanMs;

  const result: ReapResult = { deleted: 0, failed: [] };
  for (const server of servers) {
    const createdMs = Date.parse(server.created);
    // A server whose timestamp cannot be parsed is left alone (fail-safe: never
    // delete something we cannot age).
    if (Number.isNaN(createdMs) || createdMs >= cutoff) continue;
    try {
      await client.deleteServer(server.id);
      result.deleted += 1;
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      result.failed.push({ id: server.id, name: server.name, error });
    }
  }
  return result;
}
// #endregion

/**
 * Normalize a `kici-managed=hetzner-autoscale` (`key=value`) env value into the
 * Hetzner `label_selector` form (`key==value`). A value that already uses `==`
 * or names a bare key passes through.
 */
export function toLabelSelector(managedLabel: string): string {
  if (managedLabel.includes('==')) return managedLabel;
  const eq = managedLabel.indexOf('=');
  if (eq === -1) return managedLabel;
  return `${managedLabel.slice(0, eq)}==${managedLabel.slice(eq + 1)}`;
}

async function main(): Promise<void> {
  const token = process.env.HCLOUD_TOKEN;
  if (!token) {
    console.error(
      'HCLOUD_TOKEN is not set — the reaper cannot authenticate. ' +
        'Set it to a Hetzner Cloud API token for the project the servers live in, and retry.',
    );
    process.exit(2);
  }

  // `||`, not `??`: an empty value (`KICI_HETZNER_MANAGED_LABEL=` in an env
  // file) means the default label, never "no label".
  const managedLabel = toLabelSelector(
    process.env.KICI_HETZNER_MANAGED_LABEL || 'kici-managed=hetzner-autoscale',
  );
  // `||` for the same reason: an empty TTL means the default, not zero.
  const ttlRaw = process.env.KICI_HETZNER_REAP_TTL_MIN || '30';
  const ttlMin = Number(ttlRaw);
  if (!Number.isFinite(ttlMin) || ttlMin <= 0) {
    console.error(`KICI_HETZNER_REAP_TTL_MIN must be a positive number (got "${ttlRaw}")`);
    process.exit(2);
  }
  const sweepWholeProject = process.env.KICI_HETZNER_SWEEP_WHOLE_PROJECT === '1';

  // Trailing slashes are trimmed so the client can append `/servers` directly.
  const endpoint = process.env.HCLOUD_ENDPOINT?.replace(/\/+$/, '') || undefined;
  const client = new HetznerClient(token, endpoint);
  const { deleted, failed } = await reap(client, {
    managedLabel,
    olderThanMs: ttlMin * 60 * 1000,
    now: () => Date.now(),
    sweepWholeProject,
  });
  console.log(
    `hetzner-reap: deleted ${deleted} server(s) older than ${ttlMin}m ` +
      `(selector=${sweepWholeProject ? '<whole-project>' : managedLabel})`,
  );
  for (const f of failed) {
    console.error(`hetzner-reap: could not delete server ${f.id} (${f.name}): ${f.error}`);
  }

  // Emit the Prometheus textfile metric for node-exporter's textfile
  // collector, when a destination is configured. It is written even when a
  // delete failed, so the failure gauge reaches the alert. The body goes to a
  // temporary file that is then renamed over the target, so a scrape never
  // reads a half-written file. The collector reads only `*.prom`, so it skips
  // the temporary name.
  const metricFile = process.env.KICI_HETZNER_REAP_METRIC_FILE;
  if (metricFile) {
    const tmpFile = `${metricFile}.${process.pid}.tmp`;
    writeFileSync(tmpFile, renderReaperMetric(deleted, failed.length));
    renameSync(tmpFile, metricFile);
    console.log(`hetzner-reap: wrote metric ${metricFile}`);
  }
  if (failed.length > 0) process.exit(1);
}

/**
 * True when this file is the entry point (`node reap.ts`), false when it is
 * imported. Both sides are resolved to real paths: Node resolves symlinks for
 * the main module, so a symlinked `reap.ts` still runs.
 */
function invokedDirectly(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  try {
    return realpathSync(entry) === realpathSync(import.meta.filename);
  } catch {
    return false;
  }
}

if (invokedDirectly()) {
  main().catch((err) => {
    console.error('hetzner-reap failed:', err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}

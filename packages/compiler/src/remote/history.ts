/**
 * Local run history in ~/.kici/history/runs.json, read by
 * `kici run remote --history` and `kici runs show <run-id>`.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { formatRelativeTime } from '../format.js';
import picomatch from 'picomatch';
import pc from 'picocolors';
import { formatDuration } from '@kici-dev/core';
import { getConfigDir } from './config.js';
import {
  ExecutionJobStatus,
  ExecutionRunStatus,
  toCanonicalStatus,
  type CanonicalStatus,
} from '@kici-dev/engine';

const MAX_ENTRIES = 200;

export interface HistoryEntry {
  runId: string;
  fixtureId: string;
  status: CanonicalStatus;
  /** ISO timestamp */
  startedAt: string;
  /** ISO timestamp, once finished */
  completedAt?: string;
  /** Milliseconds, once finished */
  durationMs?: number;
  /** Orchestrator endpoint */
  endpoint: string;
  /** The workflow the run executed; a fixture creates one run per matched workflow. */
  workflowName?: string;
  jobs?: Array<{ name: string; status: string; durationMs?: number }>;
}

interface HistoryFilter {
  /** Exact match */
  status?: string;
  /** picomatch glob */
  fixture?: string;
  limit?: number;
}

/** Capped at MAX_ENTRIES, oldest dropped first; the file is created on first write. */
export class RunHistory {
  private readonly historyDir: string;
  private readonly historyFile: string;
  private entries: HistoryEntry[] | null = null;

  constructor(historyDir?: string) {
    this.historyDir = historyDir ?? path.join(getConfigDir(), 'history');
    this.historyFile = path.join(this.historyDir, 'runs.json');
  }

  async addEntry(entry: HistoryEntry): Promise<void> {
    const entries = await this.load();
    entries.push(entry);

    // Oldest entries are at the front.
    while (entries.length > MAX_ENTRIES) {
      entries.shift();
    }

    await this.save(entries);
  }

  /** Merges `updates` into the entry; a no-op for an unknown runId. */
  async updateEntry(runId: string, updates: Partial<HistoryEntry>): Promise<void> {
    const entries = await this.load();
    const index = entries.findIndex((e) => e.runId === runId);

    if (index === -1) {
      return;
    }

    entries[index] = { ...entries[index], ...updates };
    await this.save(entries);
  }

  /** Most recent first. Reads the cache: call load() first. */
  getEntries(filter?: HistoryFilter): HistoryEntry[] {
    const entries = this.entries ? [...this.entries] : [];

    entries.reverse();

    let filtered = entries;

    if (filter?.status) {
      filtered = filtered.filter((e) => e.status === filter.status);
    }

    if (filter?.fixture) {
      const matcher = picomatch(filter.fixture);
      filtered = filtered.filter((e) => matcher(e.fixtureId));
    }

    if (filter?.limit && filter.limit > 0) {
      filtered = filtered.slice(0, filter.limit);
    }

    return filtered;
  }

  getEntry(runId: string): HistoryEntry | undefined {
    if (!this.entries) return undefined;
    return this.entries.find((e) => e.runId === runId);
  }

  formatTable(entries: HistoryEntry[]): string {
    if (entries.length === 0) {
      return pc.gray('No run history found.');
    }

    const idWidth = Math.max(10, ...entries.map((e) => e.runId.length)) + 2;
    const fixtureWidth = Math.max(10, ...entries.map((e) => e.fixtureId.length)) + 2;

    const lines: string[] = [];

    lines.push(
      `${'Run ID'.padEnd(idWidth)}${'Fixture'.padEnd(fixtureWidth)}${'Status'.padEnd(12)}${'Duration'.padEnd(12)}Started`,
    );
    lines.push(
      `${''.padEnd(idWidth - 1, '-')} ${''.padEnd(fixtureWidth - 1, '-')} ${''.padEnd(10, '-')} ${''.padEnd(10, '-')} ${''.padEnd(15, '-')}`,
    );

    for (const entry of entries) {
      const id = entry.runId.padEnd(idWidth);
      const fixture = entry.fixtureId.padEnd(fixtureWidth);
      // Pad by the plain label's width: the ANSI escapes alone exceed the
      // column width, so padding the coloured string collapses the column.
      const statusPad = Math.max(0, 12 - statusLabelWidth(entry.status));
      const status = formatStatus(entry.status) + ' '.repeat(statusPad);
      const duration = entry.durationMs
        ? formatDuration(entry.durationMs).padEnd(12)
        : '-'.padEnd(12);
      const started = formatRelativeTime(entry.startedAt);

      lines.push(`${id}${fixture}${status}${duration}${started}`);
    }

    return lines.join('\n');
  }

  /** Caches in memory for subsequent reads. */
  async load(): Promise<HistoryEntry[]> {
    if (this.entries !== null) {
      return this.entries;
    }

    try {
      const content = await fs.readFile(this.historyFile, 'utf-8');
      this.entries = JSON.parse(content) as HistoryEntry[];
      return this.entries;
    } catch (err: unknown) {
      if (
        err instanceof Error &&
        'code' in err &&
        (err as NodeJS.ErrnoException).code === 'ENOENT'
      ) {
        this.entries = [];
        return this.entries;
      }
      throw err;
    }
  }

  private async save(entries: HistoryEntry[]): Promise<void> {
    await fs.mkdir(this.historyDir, { recursive: true });
    await fs.writeFile(this.historyFile, JSON.stringify(entries, null, 2) + '\n');
    this.entries = entries;
  }
}

type StatusDisplay = { label: string; color: (text: string) => string };

/**
 * Exhaustive by type, so a new engine status breaks the typecheck rather than
 * printing `undefined`. `label` is kept apart from `color` so column width is
 * measured on the plain label, not the ANSI escape bytes.
 */
const STATUS_DISPLAY: Readonly<Record<CanonicalStatus, StatusDisplay>> = Object.freeze({
  [ExecutionRunStatus.enum.success]: { label: 'pass', color: pc.green },
  [ExecutionRunStatus.enum.failed]: { label: 'fail', color: pc.red },
  [ExecutionJobStatus.enum.timed_out_stale]: { label: 'timeout', color: pc.red },
  [ExecutionJobStatus.enum.drift_dropped]: { label: 'dropped', color: pc.red },
  [ExecutionJobStatus.enum.unroutable]: { label: 'unroutable', color: pc.red },
  [ExecutionRunStatus.enum.cancelled]: { label: 'cancel', color: pc.yellow },
  [ExecutionRunStatus.enum.cancelling]: { label: 'cancelling', color: pc.yellow },
  [ExecutionJobStatus.enum.recovering]: { label: 'recovering', color: pc.yellow },
  [ExecutionRunStatus.enum.held]: { label: 'held', color: pc.yellow },
  [ExecutionRunStatus.enum.running]: { label: 'running', color: pc.blue },
  [ExecutionJobStatus.enum.queued]: { label: 'queued', color: pc.dim },
  [ExecutionRunStatus.enum.pending]: { label: 'pending', color: pc.dim },
  [ExecutionJobStatus.enum.skipped]: { label: 'skipped', color: pc.dim },
});

/** The plain (uncoloured) width of a status cell, for column padding. */
export function statusLabelWidth(status: string): number {
  const canonical = toCanonicalStatus(status.toLowerCase());
  return canonical === undefined ? status.length : STATUS_DISPLAY[canonical].label.length;
}

/** A status this CLI does not recognise (written by a newer version) renders verbatim. */
export function formatStatus(status: string): string {
  const canonical = toCanonicalStatus(status.toLowerCase());
  if (canonical === undefined) return pc.gray(status);
  const { label, color } = STATUS_DISPLAY[canonical];
  return color(label);
}

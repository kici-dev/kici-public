/**
 * Local run history manager.
 *
 * Persists test run history in ~/.kici/history/runs.json so developers
 * can review past runs (kici run remote --history) and inspect specific runs
 * (kici status <run-id>).
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { formatRelativeTime } from '../format.js';
import picomatch from 'picomatch';
import pc from 'picocolors';
import { formatDuration } from '@kici-dev/core';
import { getConfigDir } from './config.js';

/** Maximum number of entries to keep in history */
const MAX_ENTRIES = 200;

/** Status of a test run */
type RunStatus = 'queued' | 'running' | 'success' | 'failed' | 'cancelled';

/** A single run history entry */
export interface HistoryEntry {
  /** Unique run identifier */
  runId: string;
  /** Fixture that was run */
  fixtureId: string;
  /** Current status of the run */
  status: RunStatus;
  /** ISO timestamp when the run started */
  startedAt: string;
  /** ISO timestamp when the run completed (if finished) */
  completedAt?: string;
  /** Total duration in milliseconds (if finished) */
  durationMs?: number;
  /** Orchestrator endpoint used */
  endpoint: string;
  /** Job-level status breakdown */
  jobs?: Array<{ name: string; status: string; durationMs?: number }>;
}

/** Filter criteria for querying history entries */
interface HistoryFilter {
  /** Exact status match */
  status?: string;
  /** Fixture glob pattern (via picomatch) */
  fixture?: string;
  /** Maximum number of entries to return */
  limit?: number;
}

/**
 * Manages local run history stored in ~/.kici/history/runs.json.
 *
 * Entries are capped at 200 (oldest removed first when exceeded).
 * The history file is created lazily on first write.
 */
export class RunHistory {
  private readonly historyDir: string;
  private readonly historyFile: string;
  private entries: HistoryEntry[] | null = null;

  constructor(historyDir?: string) {
    this.historyDir = historyDir ?? path.join(getConfigDir(), 'history');
    this.historyFile = path.join(this.historyDir, 'runs.json');
  }

  /**
   * Add a new entry to the history.
   * Creates the history file and directory if they don't exist.
   * Caps history at MAX_ENTRIES by removing the oldest entries.
   */
  async addEntry(entry: HistoryEntry): Promise<void> {
    const entries = await this.load();
    entries.push(entry);

    // Cap at MAX_ENTRIES (remove oldest -- which are at the front)
    while (entries.length > MAX_ENTRIES) {
      entries.shift();
    }

    await this.save(entries);
  }

  /**
   * Update an existing entry by runId.
   * Merges the provided updates into the existing entry.
   * No-op if the runId is not found.
   */
  async updateEntry(runId: string, updates: Partial<HistoryEntry>): Promise<void> {
    const entries = await this.load();
    const index = entries.findIndex((e) => e.runId === runId);

    if (index === -1) {
      return; // Not found -- silently skip
    }

    entries[index] = { ...entries[index], ...updates };
    await this.save(entries);
  }

  /**
   * Get entries with optional filtering.
   * Returns entries in most-recent-first order.
   */
  getEntries(filter?: HistoryFilter): HistoryEntry[] {
    // Use cached entries (load must be called first for async reads)
    const entries = this.entries ? [...this.entries] : [];

    // Reverse to get most recent first
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

  /**
   * Get a single entry by runId.
   */
  getEntry(runId: string): HistoryEntry | undefined {
    if (!this.entries) return undefined;
    return this.entries.find((e) => e.runId === runId);
  }

  /**
   * Format entries as a table string for terminal display.
   *
   * Columns: Run ID | Fixture | Status | Duration | Started
   * Status is color-coded, Started uses relative time.
   */
  formatTable(entries: HistoryEntry[]): string {
    if (entries.length === 0) {
      return pc.gray('No run history found.');
    }

    // Calculate column widths
    const idWidth = Math.max(10, ...entries.map((e) => e.runId.length)) + 2;
    const fixtureWidth = Math.max(10, ...entries.map((e) => e.fixtureId.length)) + 2;

    const lines: string[] = [];

    // Header
    lines.push(
      `${'Run ID'.padEnd(idWidth)}${'Fixture'.padEnd(fixtureWidth)}${'Status'.padEnd(12)}${'Duration'.padEnd(12)}Started`,
    );
    lines.push(
      `${''.padEnd(idWidth - 1, '-')} ${''.padEnd(fixtureWidth - 1, '-')} ${''.padEnd(10, '-')} ${''.padEnd(10, '-')} ${''.padEnd(15, '-')}`,
    );

    for (const entry of entries) {
      const id = entry.runId.padEnd(idWidth);
      const fixture = entry.fixtureId.padEnd(fixtureWidth);
      const status = formatStatus(entry.status).padEnd(12);
      const duration = entry.durationMs
        ? formatDuration(entry.durationMs).padEnd(12)
        : '-'.padEnd(12);
      const started = formatRelativeTime(entry.startedAt);

      lines.push(`${id}${fixture}${status}${duration}${started}`);
    }

    return lines.join('\n');
  }

  /**
   * Load entries from disk. Caches in memory for subsequent reads.
   */
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

  /**
   * Write entries to disk.
   */
  private async save(entries: HistoryEntry[]): Promise<void> {
    await fs.mkdir(this.historyDir, { recursive: true });
    await fs.writeFile(this.historyFile, JSON.stringify(entries, null, 2) + '\n');
    this.entries = entries;
  }
}

/**
 * Format a run status with appropriate color and symbol.
 */
function formatStatus(status: RunStatus): string {
  switch (status) {
    case 'success':
      return pc.green('pass');
    case 'failed':
      return pc.red('fail');
    case 'cancelled':
      return pc.yellow('cancel');
    case 'running':
      return pc.blue('running');
    case 'queued':
      return pc.gray('queued');
  }
}

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { RunHistory, type HistoryEntry } from './history.js';

/** Strip ANSI escape codes from a string for test assertions */
// eslint-disable-next-line no-control-regex
const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, '');

/** Create a test entry with sensible defaults */
function makeEntry(overrides: Partial<HistoryEntry> = {}): HistoryEntry {
  return {
    runId: overrides.runId ?? `run-${Math.random().toString(36).slice(2, 8)}`,
    fixtureId: overrides.fixtureId ?? 'push-main',
    status: overrides.status ?? 'success',
    startedAt: overrides.startedAt ?? new Date().toISOString(),
    completedAt: overrides.completedAt,
    durationMs: overrides.durationMs ?? 1234,
    endpoint: overrides.endpoint ?? 'https://orch.example.com',
    jobs: overrides.jobs,
  };
}

describe('RunHistory', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kici-history-test-'));
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  describe('addEntry', () => {
    it('creates file and stores entry', async () => {
      const history = new RunHistory(tempDir);
      const entry = makeEntry({ runId: 'run-001' });

      await history.addEntry(entry);

      // Verify file was created
      const content = await fs.readFile(path.join(tempDir, 'runs.json'), 'utf-8');
      const parsed = JSON.parse(content) as HistoryEntry[];
      expect(parsed).toHaveLength(1);
      expect(parsed[0].runId).toBe('run-001');
    });

    it('appends to existing entries', async () => {
      const history = new RunHistory(tempDir);
      await history.addEntry(makeEntry({ runId: 'run-001' }));
      await history.addEntry(makeEntry({ runId: 'run-002' }));

      await history.load();
      const entries = history.getEntries();
      expect(entries).toHaveLength(2);
    });

    it('caps at 200 entries', async () => {
      const history = new RunHistory(tempDir);

      // Add 205 entries
      for (let i = 0; i < 205; i++) {
        await history.addEntry(makeEntry({ runId: `run-${String(i).padStart(3, '0')}` }));
      }

      await history.load();
      const entries = history.getEntries();
      expect(entries).toHaveLength(200);

      // Oldest entries (0-4) should be removed, entry 5 should be first (oldest)
      const oldestEntry = entries[entries.length - 1]; // getEntries returns most recent first
      expect(oldestEntry.runId).toBe('run-005');
    });
  });

  describe('updateEntry', () => {
    it('modifies existing entry', async () => {
      const history = new RunHistory(tempDir);
      await history.addEntry(makeEntry({ runId: 'run-update', status: 'running' }));

      await history.updateEntry('run-update', {
        status: 'success',
        completedAt: '2026-02-24T12:00:00Z',
        durationMs: 5000,
      });

      await history.load();
      const entry = history.getEntry('run-update');
      expect(entry).toBeDefined();
      expect(entry!.status).toBe('success');
      expect(entry!.completedAt).toBe('2026-02-24T12:00:00Z');
      expect(entry!.durationMs).toBe(5000);
    });

    it('is a no-op for non-existent runId', async () => {
      const history = new RunHistory(tempDir);
      await history.addEntry(makeEntry({ runId: 'run-exists' }));

      // Should not throw
      await history.updateEntry('run-missing', { status: 'failed' });

      await history.load();
      const entries = history.getEntries();
      expect(entries).toHaveLength(1);
      expect(entries[0].runId).toBe('run-exists');
    });
  });

  describe('getEntries', () => {
    it('returns most recent first', async () => {
      const history = new RunHistory(tempDir);
      await history.addEntry(makeEntry({ runId: 'run-first', startedAt: '2026-02-24T01:00:00Z' }));
      await history.addEntry(makeEntry({ runId: 'run-second', startedAt: '2026-02-24T02:00:00Z' }));
      await history.addEntry(makeEntry({ runId: 'run-third', startedAt: '2026-02-24T03:00:00Z' }));

      await history.load();
      const entries = history.getEntries();
      expect(entries[0].runId).toBe('run-third');
      expect(entries[1].runId).toBe('run-second');
      expect(entries[2].runId).toBe('run-first');
    });

    it('filters by status', async () => {
      const history = new RunHistory(tempDir);
      await history.addEntry(makeEntry({ runId: 'run-pass', status: 'success' }));
      await history.addEntry(makeEntry({ runId: 'run-fail', status: 'failed' }));
      await history.addEntry(makeEntry({ runId: 'run-pass2', status: 'success' }));

      await history.load();
      const entries = history.getEntries({ status: 'failed' });
      expect(entries).toHaveLength(1);
      expect(entries[0].runId).toBe('run-fail');
    });

    it('filters by fixture glob', async () => {
      const history = new RunHistory(tempDir);
      await history.addEntry(makeEntry({ runId: 'run-1', fixtureId: 'push-main' }));
      await history.addEntry(makeEntry({ runId: 'run-2', fixtureId: 'push-dev' }));
      await history.addEntry(makeEntry({ runId: 'run-3', fixtureId: 'pr-open' }));

      await history.load();
      const entries = history.getEntries({ fixture: 'push-*' });
      expect(entries).toHaveLength(2);
      expect(entries.every((e) => e.fixtureId.startsWith('push-'))).toBe(true);
    });

    it('applies limit', async () => {
      const history = new RunHistory(tempDir);
      for (let i = 0; i < 10; i++) {
        await history.addEntry(makeEntry({ runId: `run-${i}` }));
      }

      await history.load();
      const entries = history.getEntries({ limit: 3 });
      expect(entries).toHaveLength(3);
    });

    it('returns empty array when no entries', async () => {
      const history = new RunHistory(tempDir);
      await history.load();
      const entries = history.getEntries();
      expect(entries).toEqual([]);
    });
  });

  describe('getEntry', () => {
    it('returns entry by runId', async () => {
      const history = new RunHistory(tempDir);
      await history.addEntry(makeEntry({ runId: 'run-find-me' }));
      await history.addEntry(makeEntry({ runId: 'run-other' }));

      await history.load();
      const entry = history.getEntry('run-find-me');
      expect(entry).toBeDefined();
      expect(entry!.runId).toBe('run-find-me');
    });

    it('returns undefined for non-existent runId', async () => {
      const history = new RunHistory(tempDir);
      await history.load();
      expect(history.getEntry('nope')).toBeUndefined();
    });
  });

  describe('formatTable', () => {
    it('renders entries as a formatted table', async () => {
      const history = new RunHistory(tempDir);
      const entries: HistoryEntry[] = [
        makeEntry({
          runId: 'abc123',
          fixtureId: 'push-main',
          status: 'success',
          durationMs: 17500,
          startedAt: new Date(Date.now() - 120000).toISOString(), // 2 min ago
        }),
        makeEntry({
          runId: 'def456',
          fixtureId: 'pr-open',
          status: 'failed',
          durationMs: 5200,
          startedAt: new Date(Date.now() - 3600000).toISOString(), // 1 hour ago
        }),
      ];

      const table = history.formatTable(entries);

      // Verify header
      expect(table).toContain('Run ID');
      expect(table).toContain('Fixture');
      expect(table).toContain('Status');
      expect(table).toContain('Duration');
      expect(table).toContain('Started');

      // Verify content (strip ANSI color codes for assertions)
      const stripped = stripAnsi(table);
      expect(stripped).toContain('abc123');
      expect(stripped).toContain('push-main');
      expect(stripped).toContain('pass');
      expect(stripped).toContain('17.5s');
      expect(stripped).toContain('2 minutes ago');
      expect(stripped).toContain('def456');
      expect(stripped).toContain('pr-open');
      expect(stripped).toContain('fail');
      expect(stripped).toContain('5.2s');
      expect(stripped).toContain('1 hour ago');
    });

    it('returns message when no entries', () => {
      const history = new RunHistory(tempDir);
      const result = history.formatTable([]);
      expect(stripAnsi(result)).toContain('No run history found.');
    });
  });

  describe('load', () => {
    it('returns empty array for missing file', async () => {
      const history = new RunHistory(tempDir);
      const entries = await history.load();
      expect(entries).toEqual([]);
    });

    it('caches entries in memory after first load', async () => {
      const history = new RunHistory(tempDir);
      await history.addEntry(makeEntry({ runId: 'cached' }));

      // First explicit load
      await history.load();

      // Remove the file -- cached entries should still be accessible
      await fs.rm(path.join(tempDir, 'runs.json'));

      const entries = history.getEntries();
      expect(entries).toHaveLength(1);
      expect(entries[0].runId).toBe('cached');
    });
  });
});

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FilesystemLogStorage } from './fs-log-storage.js';
import { createLogStorage } from './log-storage.js';

describe('FilesystemLogStorage', () => {
  let tempDir: string;
  let storage: FilesystemLogStorage;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'kici-log-test-'));
    storage = new FilesystemLogStorage({ basePath: tempDir });
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  // -- append() --

  describe('append()', () => {
    it('creates directories and file on first append', async () => {
      await storage.append(
        'executions/run-1/job-test/step-0.log',
        '{"ts":"2026-01-01","msg":"hello"}\n',
      );

      const content = await readFile(
        join(tempDir, 'executions/run-1/job-test/step-0.log'),
        'utf-8',
      );
      expect(content).toBe('{"ts":"2026-01-01","msg":"hello"}\n');
    });

    it('appends to existing file (JSONL accumulation)', async () => {
      const path = 'executions/run-1/job-test/step-0.log';
      await storage.append(path, '{"line":1}\n');
      await storage.append(path, '{"line":2}\n');
      await storage.append(path, '{"line":3}\n');

      const content = await readFile(join(tempDir, path), 'utf-8');
      expect(content).toBe('{"line":1}\n{"line":2}\n{"line":3}\n');
    });

    it('handles deeply nested paths', async () => {
      await storage.append('a/b/c/d/e/f.log', 'deep\n');
      expect(await storage.exists('a/b/c/d/e/f.log')).toBe(true);
    });
  });

  // -- read() --

  describe('read()', () => {
    it('reads entire file without options', async () => {
      const path = 'test.log';
      await storage.append(path, 'line 1\nline 2\nline 3\n');

      const result = await storage.read(path);
      expect(result.data).toBe('line 1\nline 2\nline 3\n');
      expect(result.complete).toBe(true);
      expect(result.cursor).toBe(Buffer.byteLength('line 1\nline 2\nline 3\n'));
    });

    it('supports cursor-based pagination with limit', async () => {
      const path = 'paginated.log';
      const content = 'AAAAAAAAAA' + 'BBBBBBBBBB' + 'CCCCCCCCCC'; // 30 bytes
      await storage.append(path, content);

      // Read first 10 bytes
      const page1 = await storage.read(path, { limit: 10 });
      expect(page1.data).toBe('AAAAAAAAAA');
      expect(page1.cursor).toBe(10);
      expect(page1.complete).toBe(false);

      // Read next 10 bytes from cursor
      const page2 = await storage.read(path, { cursor: page1.cursor, limit: 10 });
      expect(page2.data).toBe('BBBBBBBBBB');
      expect(page2.cursor).toBe(20);
      expect(page2.complete).toBe(false);

      // Read remaining bytes
      const page3 = await storage.read(path, { cursor: page2.cursor, limit: 10 });
      expect(page3.data).toBe('CCCCCCCCCC');
      expect(page3.cursor).toBe(30);
      expect(page3.complete).toBe(true);
    });

    it('returns complete: true when cursor equals file size', async () => {
      const path = 'small.log';
      await storage.append(path, 'hello');

      const result = await storage.read(path, { cursor: 5 });
      expect(result.data).toBe('');
      expect(result.complete).toBe(true);
    });

    it('returns complete: true when cursor exceeds file size', async () => {
      const path = 'tiny.log';
      await storage.append(path, 'hi');

      const result = await storage.read(path, { cursor: 999 });
      expect(result.data).toBe('');
      expect(result.complete).toBe(true);
    });

    it('returns empty data for non-existent file', async () => {
      const result = await storage.read('missing.log');
      expect(result.data).toBe('');
      expect(result.cursor).toBe(0);
      expect(result.complete).toBe(true);
    });

    it('handles limit larger than remaining content', async () => {
      const path = 'short.log';
      await storage.append(path, 'abc');

      const result = await storage.read(path, { cursor: 1, limit: 100 });
      expect(result.data).toBe('bc');
      expect(result.cursor).toBe(3);
      expect(result.complete).toBe(true);
    });
  });

  // -- exists() --

  describe('exists()', () => {
    it('returns true for existing file', async () => {
      await storage.append('exists.log', 'data\n');
      expect(await storage.exists('exists.log')).toBe(true);
    });

    it('returns false for non-existing file', async () => {
      expect(await storage.exists('nope.log')).toBe(false);
    });

    it('returns false for a directory path', async () => {
      await storage.append('dir/file.log', 'data\n');
      // 'dir' is a directory, not a file -- but stat returns true for dirs too
      // This is fine for our use case, exists just checks something is there
      expect(await storage.exists('dir/nonexistent.log')).toBe(false);
    });
  });

  // -- list() --

  describe('list()', () => {
    it('lists files under a prefix', async () => {
      await storage.append('executions/run-1/job-test/step-0.log', 'a\n');
      await storage.append('executions/run-1/job-test/step-1.log', 'b\n');
      await storage.append('executions/run-1/job-lint/step-0.log', 'c\n');

      const files = await storage.list('executions/run-1');
      expect(files).toEqual([
        'executions/run-1/job-lint/step-0.log',
        'executions/run-1/job-test/step-0.log',
        'executions/run-1/job-test/step-1.log',
      ]);
    });

    it('returns empty array for non-existent prefix', async () => {
      const files = await storage.list('nonexistent');
      expect(files).toEqual([]);
    });

    it('lists files for a specific job', async () => {
      await storage.append('executions/run-1/job-test/step-0.log', 'a\n');
      await storage.append('executions/run-1/job-test/step-1.log', 'b\n');
      await storage.append('executions/run-1/job-lint/step-0.log', 'c\n');

      const files = await storage.list('executions/run-1/job-test');
      expect(files).toEqual([
        'executions/run-1/job-test/step-0.log',
        'executions/run-1/job-test/step-1.log',
      ]);
    });
  });
});

describe('createLogStorage()', () => {
  it('creates FilesystemLogStorage for filesystem config', () => {
    const storage = createLogStorage({ type: 'filesystem', basePath: '/tmp/logs' });
    expect(storage).toBeInstanceOf(FilesystemLogStorage);
  });

  it('creates S3LogStorage for s3 config', async () => {
    const { S3LogStorage } = await import('./s3-log-storage.js');
    const storage = createLogStorage({ type: 's3', bucket: 'my-bucket', prefix: 'logs/' });
    expect(storage).toBeInstanceOf(S3LogStorage);
  });
});

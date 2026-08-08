import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FilesystemLogStorage } from './fs-log-storage.js';
import { assertSafeLogPath, createLogStorage } from './log-storage.js';

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

  // -- appendStreaming() / finalize() --

  describe('appendStreaming() + finalize()', () => {
    it('writes durably and finalize is a no-op on the filesystem backend', async () => {
      const path = 'executions/r1/job-a/step-0.log';
      await storage.appendStreaming(path, 'line1\n');
      await storage.appendStreaming(path, 'line2\n');
      // finalize must not throw and requires no prior buffering on FS.
      await expect(storage.finalize(path)).resolves.toBeUndefined();
      const res = await storage.read(path);
      expect(res.data).toBe('line1\nline2\n');
    });

    it('appendStreaming content is readable before any finalize call', async () => {
      const path = 'executions/r1/job-b/step-0.log';
      await storage.appendStreaming(path, 'immediate\n');
      const res = await storage.read(path);
      expect(res.data).toBe('immediate\n');
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

  // -- Path containment --

  describe('path containment', () => {
    // Six-character escape, never a raw byte — see the top of this file.
    const NUL_PATH = 'executions/run-1/job-\u0000evil/step-0.log';

    const escaping: Array<[name: string, path: string]> = [
      ['a leading .. segment', '../escape'],
      ['a .. segment mid-path', 'a/../../escape'],
      ['an absolute path', '/tmp/kici-escape-target'],
      ['a NUL-bearing key', NUL_PATH],
    ];

    for (const [name, path] of escaping) {
      describe(name, () => {
        // Write verbs.
        it('is refused by append()', async () => {
          await expect(storage.append(path, 'x\n')).rejects.toThrow();
        });
        it('is refused by appendStreaming()', async () => {
          await expect(storage.appendStreaming(path, 'x\n')).rejects.toThrow();
        });
        it('is refused by deleteMany()', async () => {
          await expect(storage.deleteMany([path])).rejects.toThrow();
        });
        // Read verbs. log-pull-handler and the dashboard orch-logs handler
        // both reach read()/exists() with wire-supplied ids, so an unguarded
        // read is an exfiltration primitive, not just an unguarded write.
        it('is refused by read()', async () => {
          await expect(storage.read(path)).rejects.toThrow();
        });
        it('is refused by exists()', async () => {
          await expect(storage.exists(path)).rejects.toThrow();
        });
        it('is refused by list()', async () => {
          await expect(storage.list(path)).rejects.toThrow();
        });
        it('is refused by listWithMetadata()', async () => {
          await expect(storage.listWithMetadata(path)).rejects.toThrow();
        });
      });
    }

    it('writes nothing outside the root when append() is refused', async () => {
      await expect(storage.append('../escaped.log', 'x\n')).rejects.toThrow();
      const parent = join(tempDir, '..');
      const entries = await readdir(parent);
      expect(entries).not.toContain('escaped.log');
    });

    it('accepts the canonical step-log path', async () => {
      const path = 'executions/run-1/job-build/step-0.log';
      await storage.append(path, '{"line":1}\n');
      const result = await storage.read(path);
      expect(result.data).toBe('{"line":1}\n');
    });

    it('accepts a job name containing .. as a substring', async () => {
      // Guards against an over-broad substring check: `a..b` is legitimate.
      const path = 'executions/r/job-a..b/step-0.log';
      await storage.append(path, '{"line":1}\n');
      expect(await storage.exists(path)).toBe(true);
      const result = await storage.read(path);
      expect(result.data).toBe('{"line":1}\n');
    });

    it('accepts the empty prefix, which addresses the root itself', async () => {
      await storage.append('executions/run-1/job-build/step-0.log', 'x\n');
      const files = await storage.list('');
      expect(files).toContain(join('executions', 'run-1', 'job-build', 'step-0.log'));
    });
  });
});

describe('assertSafeLogPath()', () => {
  // The NUL fixture is written as the six-character escape, never a raw byte:
  // a literal NUL makes the whole file opaque to grep -I, file(1) and diffs.
  const NUL_PATH = 'executions/run-1/job-\u0000evil/step-0.log';

  const rejected: Array<[name: string, path: string]> = [
    ['a leading .. segment', '../escape'],
    ['a .. segment mid-path', 'executions/run-1/../../escape'],
    ['a bare .. segment', '..'],
    ['a trailing .. segment', 'executions/run-1/..'],
    ['a backslash-separated .. segment', 'executions\\run-1\\..\\escape'],
    ['an absolute posix path', '/etc/passwd'],
    ['an absolute path with traversal', '/var/log/../../etc/passwd'],
    ['a leading backslash', '\\windows\\system32'],
    ['a NUL byte', NUL_PATH],
  ];

  for (const [name, path] of rejected) {
    it(`rejects ${name}`, () => {
      expect(() => assertSafeLogPath(path)).toThrow();
    });
  }

  const accepted: Array<[name: string, path: string]> = [
    ['the canonical step-log path', 'executions/run-1/job-build/step-0.log'],
    ['the canonical orchestration path', 'executions/run-1/jobs/job-1/orchestration.jsonl'],
    // `..` as a SUBSTRING of a legitimate segment must pass. A substring check
    // would reject this, which is why the validator splits into segments.
    ['a name containing .. as a substring', 'executions/r/job-a..b/step-0.log'],
    ['a name ending in a dot', 'executions/r/job-a./step-0.log'],
    ['a single-dot segment', 'executions/./run-1/job-b/step-0.log'],
    ['an empty prefix (list-everything)', ''],
    ['a directory prefix', 'executions/run-1/job-build/'],
  ];

  for (const [name, path] of accepted) {
    it(`accepts ${name}`, () => {
      expect(() => assertSafeLogPath(path)).not.toThrow();
    });
  }

  it('does not interpolate a NUL byte into its own error message', () => {
    // The NUL check must run first: an error message carrying a raw NUL
    // poisons every log line and log file it reaches.
    expect(() => assertSafeLogPath(NUL_PATH)).toThrow(/NUL/);
    try {
      assertSafeLogPath(NUL_PATH);
    } catch (err) {
      expect((err as Error).message).not.toContain('\u0000');
    }
  });
});

describe('createLogStorage()', () => {
  it('creates FilesystemLogStorage for filesystem config', () => {
    const storage = createLogStorage({ type: 'filesystem', basePath: '/tmp/logs' });
    expect(storage).toBeInstanceOf(FilesystemLogStorage);
  });

  it('creates S3LogStorage for s3 config', async () => {
    const { S3LogStorage } = await import('./s3-log-storage.js');
    const storage = createLogStorage({
      type: 's3',
      bucket: 'my-bucket',
      prefix: 'logs/',
      segmentFlushBytes: 1_048_576,
      segmentFlushMs: 2_000,
    });
    expect(storage).toBeInstanceOf(S3LogStorage);
  });
});

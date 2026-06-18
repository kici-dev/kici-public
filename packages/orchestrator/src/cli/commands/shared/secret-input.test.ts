import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { Readable } from 'node:stream';
import { promises as fs } from 'node:fs';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveSecretInput, fingerprintValue } from './secret-input.js';

class FakeStderr {
  chunks: string[] = [];
  write(s: string): boolean {
    this.chunks.push(s);
    return true;
  }
  joined(): string {
    return this.chunks.join('');
  }
}

function makeTtyStdin(value: string, raw = true): NodeJS.ReadStream {
  // Simulate readline behavior: emit the value followed by '\n'.
  const stream = Readable.from([value + '\n']) as unknown as NodeJS.ReadStream;
  Object.defineProperty(stream, 'isTTY', { value: raw, configurable: true });
  (stream as any).setRawMode = () => stream;
  return stream;
}

function makePipedStdin(value: string): NodeJS.ReadStream {
  const stream = Readable.from([value]) as unknown as NodeJS.ReadStream;
  Object.defineProperty(stream, 'isTTY', { value: false, configurable: true });
  return stream;
}

describe('resolveSecretInput', () => {
  let tmp: string;
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'kici-secret-input-'));
    delete process.env.KICI_TEST_SECRET;
  });
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
    delete process.env.KICI_TEST_SECRET;
    vi.restoreAllMocks();
  });

  describe('mode resolution', () => {
    it('rejects ambiguous combinations (--value + --from-stdin)', async () => {
      await expect(
        resolveSecretInput({ value: 'x', fromStdin: true }, new FakeStderr() as any),
      ).rejects.toThrow(/Ambiguous input mode/);
    });

    it('rejects ambiguous combinations (--from-file + --from-env)', async () => {
      await expect(
        resolveSecretInput({ fromFile: '/dev/null', fromEnv: 'X' }, new FakeStderr() as any),
      ).rejects.toThrow(/Ambiguous input mode/);
    });

    it('rejects --prompt + --from-stdin', async () => {
      await expect(
        resolveSecretInput({ prompt: true, fromStdin: true }, new FakeStderr() as any),
      ).rejects.toThrow(/Ambiguous input mode/);
    });
  });

  describe('--value', () => {
    it('returns the value and emits a stderr warning', async () => {
      const err = new FakeStderr();
      const result = await resolveSecretInput({ value: 'sk_live_123' }, err as any);
      expect(result.value).toBe('sk_live_123');
      expect(result.source).toBe('value');
      expect(err.joined()).toMatch(/--value puts the secret in shell history/);
    });

    it('warns about empty value', async () => {
      const err = new FakeStderr();
      const result = await resolveSecretInput({ value: '' }, err as any);
      expect(result.value).toBe('');
      expect(err.joined()).toMatch(/value is empty/);
    });
  });

  describe('--from-env', () => {
    it('reads from named env var', async () => {
      process.env.KICI_TEST_SECRET = 'env_value_42';
      const result = await resolveSecretInput(
        { fromEnv: 'KICI_TEST_SECRET' },
        new FakeStderr() as any,
      );
      expect(result.value).toBe('env_value_42');
      expect(result.source).toBe('env');
    });

    it('errors when env var is unset', async () => {
      await expect(
        resolveSecretInput({ fromEnv: 'KICI_TEST_SECRET' }, new FakeStderr() as any),
      ).rejects.toThrow(/environment variable is not set/);
    });
  });

  describe('--from-file', () => {
    it('reads file contents and trims trailing newline by default', async () => {
      const path = join(tmp, 'secret.txt');
      await fs.writeFile(path, 'file_value_77\n', 'utf8');
      const result = await resolveSecretInput({ fromFile: path }, new FakeStderr() as any);
      expect(result.value).toBe('file_value_77');
      expect(result.source).toBe('file');
    });

    it('preserves trailing newline when --trim=false', async () => {
      const path = join(tmp, 'secret.txt');
      await fs.writeFile(path, 'file_value\n', 'utf8');
      const result = await resolveSecretInput(
        { fromFile: path, trim: false },
        new FakeStderr() as any,
      );
      expect(result.value).toBe('file_value\n');
    });

    it('throws when file missing', async () => {
      await expect(
        resolveSecretInput({ fromFile: join(tmp, 'nope.txt') }, new FakeStderr() as any),
      ).rejects.toThrow();
    });
  });

  describe('--from-stdin', () => {
    it('reads piped stdin (default when no TTY)', async () => {
      const result = await resolveSecretInput(
        {},
        new FakeStderr() as any,
        makePipedStdin('piped_value\n'),
      );
      expect(result.value).toBe('piped_value');
      expect(result.source).toBe('stdin');
    });

    it('errors when --from-stdin given but stdin is a TTY', async () => {
      await expect(
        resolveSecretInput({ fromStdin: true }, new FakeStderr() as any, makeTtyStdin('x')),
      ).rejects.toThrow(/requires piped input/);
    });
  });

  describe('--confirm-fingerprint', () => {
    it('accepts matching fingerprint (case-insensitive)', async () => {
      const value = 'fp-value';
      const fp = fingerprintValue(value).toUpperCase();
      const result = await resolveSecretInput(
        { value, confirmFingerprint: fp },
        new FakeStderr() as any,
      );
      expect(result.value).toBe(value);
    });

    it('rejects mismatched fingerprint', async () => {
      await expect(
        resolveSecretInput(
          { value: 'real', confirmFingerprint: 'a'.repeat(64) },
          new FakeStderr() as any,
        ),
      ).rejects.toThrow(/--confirm-fingerprint mismatch/);
    });

    it('rejects malformed fingerprint', async () => {
      await expect(
        resolveSecretInput(
          { value: 'real', confirmFingerprint: 'not-a-hash' },
          new FakeStderr() as any,
        ),
      ).rejects.toThrow(/must be a SHA-256 hex string/);
    });
  });
});

describe('fingerprintValue', () => {
  it('returns deterministic SHA-256 hex of utf-8 bytes', () => {
    expect(fingerprintValue('hello')).toBe(
      '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824',
    );
  });
});

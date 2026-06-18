import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { firstWritableDir, resolveDataDir } from './data-dir.js';

describe('firstWritableDir', () => {
  const created: string[] = [];
  afterEach(() => {
    for (const p of created) rmSync(p, { recursive: true, force: true });
    created.length = 0;
  });

  it('returns the first candidate that can be created and written', () => {
    const good = join(tmpdir(), `kici-dd-${randomUUID()}`);
    created.push(good);
    expect(firstWritableDir([good])).toBe(good);
    expect(statSync(good).isDirectory()).toBe(true);
  });

  it('skips a candidate that cannot be created and falls through to a writable one', () => {
    // A path nested under a regular FILE cannot be mkdir'd (ENOTDIR), so it is
    // skipped and the next writable candidate wins.
    const file = join(tmpdir(), `kici-dd-file-${randomUUID()}`);
    writeFileSync(file, 'x');
    created.push(file);
    const good = join(tmpdir(), `kici-dd-${randomUUID()}`);
    created.push(good);

    const unwritable = join(file, 'cannot', 'exist');
    expect(firstWritableDir([unwritable, good])).toBe(good);
  });

  it('throws when no candidate is writable', () => {
    const file = join(tmpdir(), `kici-dd-file2-${randomUUID()}`);
    writeFileSync(file, 'x');
    created.push(file);
    expect(() => firstWritableDir([join(file, 'nope')])).toThrow();
  });
});

describe('resolveDataDir', () => {
  const created: string[] = [];
  afterEach(() => {
    for (const p of created) rmSync(p, { recursive: true, force: true });
    created.length = 0;
  });

  it('uses and creates an explicit data dir when configured', () => {
    const explicit = join(tmpdir(), `kici-explicit-${randomUUID()}`);
    created.push(explicit);
    expect(resolveDataDir(explicit)).toBe(explicit);
    expect(existsSync(explicit)).toBe(true);
  });

  it('falls back to an XDG_STATE_HOME path when /var/lib/kici is not writable', () => {
    // Point XDG_STATE_HOME at a writable tmp dir. /var/lib/kici is the first
    // candidate; on the CI sandbox it is not writable, so the resolver must
    // fall through to <XDG_STATE_HOME>/kici. We assert the result is a
    // writable directory — either /var/lib/kici (if the runner happens to own
    // it) or the XDG fallback — never a throw.
    const xdg = mkdtempSync(join(tmpdir(), 'kici-xdg-'));
    created.push(xdg);
    const original = process.env.XDG_STATE_HOME;
    process.env.XDG_STATE_HOME = xdg;
    try {
      const resolved = resolveDataDir(undefined);
      expect(statSync(resolved).isDirectory()).toBe(true);
      // When /var/lib/kici is unavailable the XDG path is chosen.
      if (resolved !== '/var/lib/kici') {
        expect(resolved).toBe(join(xdg, 'kici'));
      }
    } finally {
      if (original === undefined) delete process.env.XDG_STATE_HOME;
      else process.env.XDG_STATE_HOME = original;
    }
  });
});

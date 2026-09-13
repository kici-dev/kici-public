import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { copyFileSecurelySync, writeFileSecurely, writeFileSecurelySync } from './secure-write.js';

describe('secure write', () => {
  let dir = '';
  afterEach(() => {
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
    dir = '';
  });

  function mkdir(): string {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kici-secure-write-'));
    return dir;
  }

  it('creates the file at the requested mode', () => {
    const target = path.join(mkdir(), 'svc.env');
    writeFileSecurelySync(target, 'KICI_SECRET_KEY=abc\n', 0o600);
    expect(fs.statSync(target).mode & 0o777).toBe(0o600);
    expect(fs.readFileSync(target, 'utf-8')).toBe('KICI_SECRET_KEY=abc\n');
  });

  // fails-when: the write goes through `writeFileSync(p, c, { mode })`, whose
  //   mode applies only on creation — the destination then keeps 0644 and the
  //   secret is world-readable until a later chmod. Reading the mode after the
  //   call is what catches it; asserting the content would pass either way.
  it('replaces a world-readable destination without ever widening it', () => {
    const target = path.join(mkdir(), 'svc.env');
    fs.writeFileSync(target, 'old\n', { encoding: 'utf-8', mode: 0o644 });
    fs.chmodSync(target, 0o644);

    writeFileSecurelySync(target, 'KICI_SECRET_KEY=abc\n', 0o600);

    expect(fs.statSync(target).mode & 0o777).toBe(0o600);
    expect(fs.readFileSync(target, 'utf-8')).toBe('KICI_SECRET_KEY=abc\n');
  });

  // fails-when: the copy uses `copyFileSync`, which reproduces the source's
  //   mode on the destination.
  it('copies a world-readable source to an owner-only destination', () => {
    const base = mkdir();
    const source = path.join(base, 'source.env');
    const target = path.join(base, 'svc.env');
    fs.writeFileSync(source, 'KICI_SECRET_KEY=abc\n', { encoding: 'utf-8', mode: 0o644 });
    fs.chmodSync(source, 0o644);

    copyFileSecurelySync(source, target, 0o600);

    expect(fs.statSync(target).mode & 0o777).toBe(0o600);
    expect(fs.readFileSync(target, 'utf-8')).toBe('KICI_SECRET_KEY=abc\n');
    // breaks-if-wrong: the source is read, never moved or altered.
    expect(fs.statSync(source).mode & 0o777).toBe(0o644);
  });

  // The window itself, made observable. A second hard link names the
  // destination's original inode, so if the write went *through* that inode
  // the keeper would show the new content — which is exactly the state in
  // which the secret sits at 0644 until a chmod catches up. A rename puts the
  // content on a fresh inode instead, so the old one keeps its old bytes and
  // its old mode.
  //
  // fails-when: the site writes with `writeFileSync(p, c, { mode })` + chmod,
  //   or copies with `copyFileSync` + chmod.
  it('never writes through the destination inode it replaces', () => {
    const base = mkdir();
    const target = path.join(base, 'svc.env');
    const keeper = path.join(base, 'keeper');
    fs.writeFileSync(target, 'old\n', { encoding: 'utf-8', mode: 0o644 });
    fs.chmodSync(target, 0o644);
    fs.linkSync(target, keeper);

    writeFileSecurelySync(target, 'KICI_SECRET_KEY=abc\n', 0o600);

    expect(fs.readFileSync(keeper, 'utf-8')).toBe('old\n');
    expect(fs.statSync(keeper).mode & 0o777).toBe(0o644);
    expect(fs.statSync(target).ino).not.toBe(fs.statSync(keeper).ino);
  });

  it('leaves no staging file behind on success', () => {
    const base = mkdir();
    writeFileSecurelySync(path.join(base, 'svc.env'), 'x\n', 0o600);
    expect(fs.readdirSync(base)).toEqual(['svc.env']);
  });

  // breaks-if-wrong: a failed write must not leave a half-written temp file in
  //   the destination directory for the next run to trip over.
  it('cleans up the staging file when the rename cannot happen', () => {
    const base = mkdir();
    const target = path.join(base, 'nested', 'svc.env');
    expect(() => writeFileSecurelySync(target, 'x\n', 0o600)).toThrow();
    expect(fs.existsSync(path.join(base, 'nested'))).toBe(false);
    expect(fs.readdirSync(base)).toEqual([]);
  });

  it('the promise form behaves the same way', async () => {
    const target = path.join(mkdir(), 'svc.env');
    fs.writeFileSync(target, 'old\n', { encoding: 'utf-8', mode: 0o644 });
    fs.chmodSync(target, 0o644);

    await writeFileSecurely(target, 'KICI_SECRET_KEY=abc\n', 0o600);

    expect(fs.statSync(target).mode & 0o777).toBe(0o600);
    expect(fs.readFileSync(target, 'utf-8')).toBe('KICI_SECRET_KEY=abc\n');
  });
});

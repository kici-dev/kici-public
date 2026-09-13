import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PLANE_LOG_MAX_BYTES, rotatePlaneLogIfOversized } from './plane-log.js';

/** A file of exactly `size` bytes, cheaply (sparse), inside a fresh temp dir. */
function seedLog(size: number): { dir: string; file: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kici-planelog-'));
  const file = path.join(dir, 'orchestrator.log');
  fs.writeFileSync(file, '');
  fs.truncateSync(file, size);
  return { dir, file };
}

describe('rotatePlaneLogIfOversized', () => {
  it('pins the cap at 50 MB', () => {
    // fails-when: the constant is edited to any other value. Every other test
    // in this file sizes its fixture FROM the constant, so this literal is the
    // only assertion that can notice the cap itself moving.
    expect(PLANE_LOG_MAX_BYTES).toBe(50 * 1024 * 1024);
  });

  it('rotates a log that is over the cap', () => {
    // fails-when: a log of PLANE_LOG_MAX_BYTES + 1 bytes — with no size check
    // at all this still passes, so the under-cap case below is its counterpart.
    const { dir, file } = seedLog(PLANE_LOG_MAX_BYTES + 1);
    try {
      rotatePlaneLogIfOversized(file);
      expect(fs.existsSync(file)).toBe(false);
      expect(fs.statSync(`${file}.1`).size).toBe(PLANE_LOG_MAX_BYTES + 1);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rotates a log that is exactly at the cap', () => {
    // fails-when: a log of exactly PLANE_LOG_MAX_BYTES bytes — pins the
    // boundary, so `>` cannot be substituted for `>=` unnoticed.
    const { dir, file } = seedLog(PLANE_LOG_MAX_BYTES);
    try {
      rotatePlaneLogIfOversized(file);
      expect(fs.statSync(`${file}.1`).size).toBe(PLANE_LOG_MAX_BYTES);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('leaves a log under the cap alone', () => {
    // breaks-if-wrong: an unconditional rotate would discard the previous
    // boot's log on every plane start, which is the failure this whole change
    // must not introduce while fixing unbounded growth.
    const { dir, file } = seedLog(0);
    try {
      fs.writeFileSync(file, 'keep me\n');
      rotatePlaneLogIfOversized(file);
      expect(fs.existsSync(`${file}.1`)).toBe(false);
      expect(fs.readFileSync(file, 'utf-8')).toBe('keep me\n');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('keeps two generations — the previous .1 is discarded', () => {
    // fails-when: a stale .1 already exists and the rotation either skips (the
    // over-cap log stays live) or shifts the old generation to .2 instead of
    // discarding it. The new bytes must land in .1 and nothing else is kept.
    // It does not pin the rmSync: rename(2) replaces an existing target, so
    // the property holds with or without it.
    const { dir, file } = seedLog(PLANE_LOG_MAX_BYTES + 1);
    try {
      fs.writeFileSync(`${file}.1`, 'older generation\n');
      rotatePlaneLogIfOversized(file);
      expect(fs.statSync(`${file}.1`).size).toBe(PLANE_LOG_MAX_BYTES + 1);
      expect(fs.existsSync(`${file}.2`)).toBe(false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('does not throw when the log does not exist yet', () => {
    // breaks-if-wrong: the first boot of a fresh plane has no log file. A throw
    // here fails the orchestrator boot outright, and inside startPlanePostgres
    // it is swallowed into a silent fallback to a Podman container.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kici-planelog-'));
    try {
      expect(() => rotatePlaneLogIfOversized(path.join(dir, 'absent.log'))).not.toThrow();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

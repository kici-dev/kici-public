import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { renderPostReceiveHook, installPostReceiveHook } from './local-hook.js';

describe('renderPostReceiveHook', () => {
  it('renders a hook that calls trigger-local for the source id', () => {
    const script = renderPostReceiveHook({ sourceId: 'src-1', baseUrl: 'http://127.0.0.1:10143' });
    expect(script).toContain('#!/usr/bin/env bash');
    expect(script).toContain('kici-admin source trigger-local src-1');
    expect(script).toContain('--base-url http://127.0.0.1:10143');
    // Forwards the pushed ref + sha from stdin so each branch push triggers.
    expect(script).toContain('--ref');
    expect(script).toContain('--sha');
  });
});

describe('installPostReceiveHook', () => {
  let dirs: string[] = [];

  afterEach(() => {
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
    dirs = [];
  });

  it('writes an executable post-receive hook into .git/hooks', () => {
    const repo = mkdtempSync(join(tmpdir(), 'kici-hook-repo-'));
    dirs.push(repo);
    mkdirSync(join(repo, '.git', 'hooks'), { recursive: true });
    const script = renderPostReceiveHook({ sourceId: 'src-1', baseUrl: 'http://x' });
    const hookPath = installPostReceiveHook(repo, script);
    expect(hookPath).toBe(join(repo, '.git', 'hooks', 'post-receive'));
    expect(readFileSync(hookPath, 'utf8')).toBe(script);
    // Executable bit set.
    expect(statSync(hookPath).mode & 0o111).not.toBe(0);
  });

  it('throws when the path is not a git repo (no .git/hooks)', () => {
    const notARepo = mkdtempSync(join(tmpdir(), 'kici-not-repo-'));
    dirs.push(notARepo);
    expect(() => installPostReceiveHook(notARepo, 'x')).toThrow(/not a git repo/i);
  });
});

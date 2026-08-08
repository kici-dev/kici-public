import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { EventPayload } from '@kici-dev/sdk';
import { computeChangedFiles, buildAuthCtx } from './changed-files.js';

let dir: string;
const git = (args: string[]) =>
  execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' }).trim();

async function commit(files: Record<string, string>, message: string): Promise<string> {
  for (const [p, body] of Object.entries(files)) {
    await mkdir(join(dir, p, '..'), { recursive: true }).catch(() => {});
    await writeFile(join(dir, p), body);
  }
  git(['add', '-A']);
  git(['commit', '-m', message]);
  return git(['rev-parse', 'HEAD']);
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'kici-cf-'));
  git(['init', '-q', '-b', 'main']);
  git(['config', 'user.email', 't@t']);
  git(['config', 'user.name', 't']);
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('computeChangedFiles', () => {
  it('push: diffs before..HEAD', async () => {
    const before = await commit({ 'a.ts': '1' }, 'first');
    await commit({ 'docs/b.md': 'x', 'c.ts': 'y' }, 'second');
    const event = { type: 'push', payload: { before } } as unknown as EventPayload;
    const res = await computeChangedFiles(dir, event);
    expect(res.status).toBe('fetched');
    expect(res.files.sort()).toEqual(['c.ts', 'docs/b.md']);
  });

  it('push: new branch (zero before) → all files vs empty tree', async () => {
    await commit({ 'a.ts': '1', 'b.md': '2' }, 'first');
    const event = {
      type: 'push',
      payload: { before: '0000000000000000000000000000000000000000' },
    } as unknown as EventPayload;
    const res = await computeChangedFiles(dir, event);
    expect(res.status).toBe('fetched');
    expect(res.files.sort()).toEqual(['a.ts', 'b.md']);
  });

  it('pull_request: diffs base...HEAD (only the PR changes)', async () => {
    await commit({ 'a.ts': '1' }, 'base');
    git(['checkout', '-q', '-b', 'feature']);
    await commit({ 'feature.ts': 'x', 'docs/f.md': 'y' }, 'feature work');
    const event = {
      type: 'pull_request',
      baseBranch: 'main',
      targetBranch: 'main',
    } as unknown as EventPayload;
    const res = await computeChangedFiles(dir, event);
    expect(res.status).toBe('fetched');
    expect(res.files.sort()).toEqual(['docs/f.md', 'feature.ts']);
  });

  it('diff-less event (schedule) → unavailable', async () => {
    await commit({ 'a.ts': '1' }, 'first');
    const res = await computeChangedFiles(dir, { type: 'schedule' } as unknown as EventPayload);
    expect(res).toEqual({ files: [], status: 'unavailable' });
  });

  it('git failure (bad before sha) → unavailable, never throws', async () => {
    await commit({ 'a.ts': '1' }, 'first');
    const event = {
      type: 'push',
      payload: { before: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef' },
    } as unknown as EventPayload;
    const res = await computeChangedFiles(dir, event);
    expect(res).toEqual({ files: [], status: 'unavailable' });
  });
});

describe('buildAuthCtx', () => {
  it('no auth → empty args, no env, no cleanup', async () => {
    const ctx = await buildAuthCtx(undefined);
    expect(ctx.args).toEqual([]);
    expect(ctx.env).toBeUndefined();
    expect(ctx.cleanup).toBeUndefined();
  });

  it('basic auth → http.extraHeader flag (base64 of user:secret)', async () => {
    const ctx = await buildAuthCtx({ kind: 'basic', user: 'x-access-token', secret: 'tok123' });
    const expected = Buffer.from('x-access-token:tok123').toString('base64');
    expect(ctx.args).toEqual(['-c', `http.extraHeader=Authorization: Basic ${expected}`]);
    expect(ctx.env).toBeUndefined();
  });

  it('basic auth defaults the username to x-access-token', async () => {
    const ctx = await buildAuthCtx({ kind: 'basic', secret: 'tok' });
    const expected = Buffer.from('x-access-token:tok').toString('base64');
    expect(ctx.args[1]).toBe(`http.extraHeader=Authorization: Basic ${expected}`);
  });

  it('ssh auth → GIT_SSH_COMMAND env + a cleanup that removes the temp key', async () => {
    const key = '-----BEGIN OPENSSH PRIVATE KEY-----\nabc\n-----END OPENSSH PRIVATE KEY-----\n';
    const ctx = await buildAuthCtx({ kind: 'ssh', secret: key });
    try {
      expect(ctx.args).toEqual([]);
      expect(ctx.env?.GIT_SSH_COMMAND).toMatch(/^ssh /);
      expect(typeof ctx.cleanup).toBe('function');
    } finally {
      await ctx.cleanup?.();
    }
  });
});

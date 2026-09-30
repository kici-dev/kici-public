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
    const after = await commit({ 'docs/b.md': 'x', 'c.ts': 'y' }, 'second');
    const event = {
      type: 'push',
      targetBranch: 'main',
      payload: { before, after },
    } as unknown as EventPayload;
    const res = await computeChangedFiles(dir, event);
    expect(res.status).toBe('fetched');
    expect(res.files.sort()).toEqual(['c.ts', 'docs/b.md']);
  });

  // A cross-source job checks out the registration's commit, not the pushed one.
  // fails-when: the push diffs before..HEAD, which here lists a.ts / docs/b.md instead of src/c.ts
  it('push: diffs before..after when the checkout is at another commit', async () => {
    const checkedOut = await commit({ 'a.ts': '1' }, 'registration commit');
    const before = await commit({ 'docs/b.md': 'x' }, 'before');
    const after = await commit({ 'src/c.ts': 'y' }, 'after');
    git(['checkout', '-q', '--detach', checkedOut]);
    const res = await computeChangedFiles(dir, {
      type: 'push',
      targetBranch: 'main',
      payload: { before, after },
    } as unknown as EventPayload);
    expect(res).toEqual({ files: ['src/c.ts'], status: 'fetched' });
  });

  // fails-when: the new-branch diff reads HEAD, which here adds nothing relative to main
  it('new branch: diffs the default branch against after when the checkout is elsewhere', async () => {
    const base = await commit({ 'a.ts': '1' }, 'base');
    git(['checkout', '-q', '-b', 'feature']);
    const after = await commit({ 'src/new.ts': 'x' }, 'feature work');
    git(['checkout', '-q', '--detach', base]);
    const res = await computeChangedFiles(dir, {
      type: 'push',
      targetBranch: 'feature',
      defaultBranch: 'main',
      payload: { before: '0'.repeat(40), after },
    } as unknown as EventPayload);
    expect(res).toEqual({ files: ['src/new.ts'], status: 'fetched' });
  });

  it('new branch: the files the branch adds relative to the default branch', async () => {
    await commit({ 'a.ts': '1' }, 'base');
    git(['checkout', '-q', '-b', 'feature']);
    await commit({ 'src/new.ts': 'x' }, 'feature work');
    git(['checkout', '-q', 'main']);
    // The default branch advances after the branch point: its file must not count.
    await commit({ 'main-only.ts': 'y' }, 'main moves on');
    git(['checkout', '-q', 'feature']);
    const head = git(['rev-parse', 'HEAD']);
    const res = await computeChangedFiles(dir, {
      type: 'push',
      targetBranch: 'feature',
      defaultBranch: 'main',
      payload: { before: '0'.repeat(40), after: head },
    } as unknown as EventPayload);
    expect(res).toEqual({ files: ['src/new.ts'], status: 'fetched' });
  });

  it('new branch: the default branch falls back to payload.repository.default_branch', async () => {
    await commit({ 'a.ts': '1' }, 'base');
    git(['checkout', '-q', '-b', 'feature']);
    const head = await commit({ 'src/new.ts': 'x' }, 'feature work');
    const res = await computeChangedFiles(dir, {
      type: 'push',
      targetBranch: 'feature',
      payload: { before: '0'.repeat(40), after: head, repository: { default_branch: 'main' } },
    } as unknown as EventPayload);
    expect(res).toEqual({ files: ['src/new.ts'], status: 'fetched' });
  });

  // fails-when: a range-less push reads as "every tracked file changed"
  it('push with no before is unavailable, not the whole tree', async () => {
    const b = await commit({ 'a.ts': '1' }, 'a');
    const res = await computeChangedFiles(dir, {
      type: 'push',
      targetBranch: 'main',
      payload: { after: b },
    } as unknown as EventPayload);
    expect(res).toEqual({ files: [], status: 'unavailable' });
  });

  it('new branch pushed as the default branch itself is unavailable', async () => {
    const head = await commit({ 'a.ts': '1' }, 'a');
    const res = await computeChangedFiles(dir, {
      type: 'push',
      targetBranch: 'main',
      defaultBranch: 'main',
      payload: { before: '0'.repeat(40), after: head },
    } as unknown as EventPayload);
    expect(res).toEqual({ files: [], status: 'unavailable' });
  });

  it('deleted branch: fetched, no files', async () => {
    const a = await commit({ 'a.ts': '1' }, 'a');
    const res = await computeChangedFiles(dir, {
      type: 'push',
      targetBranch: 'main',
      payload: { before: a, after: '0'.repeat(40) },
    } as unknown as EventPayload);
    expect(res).toEqual({ files: [], status: 'fetched' });
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

  describe('in a shallow single-branch clone, as the agent clones', () => {
    /**
     * Build an origin whose `main` advanced after `feature` branched off, and
     * clone only `feature` the way the agent does (`clone --depth --branch`,
     * which implies `--single-branch`): the clone holds no `main` ref at all.
     */
    async function cloneFeatureOnly(): Promise<{ clone: string; head: string }> {
      await commit({ 'a.ts': '1' }, 'base');
      git(['checkout', '-q', '-b', 'feature']);
      await commit({ 'src/new.ts': 'x' }, 'feature work');
      git(['checkout', '-q', 'main']);
      await commit({ 'main-only.ts': 'y' }, 'main moves on');
      const clone = join(dir, '..', `${dir.split('/').pop()}-clone`);
      // file:// makes --depth apply; a plain path clone ignores it.
      execFileSync('git', [
        'clone',
        '-q',
        '--depth',
        '1',
        '--branch',
        'feature',
        `file://${dir}`,
        clone,
      ]);
      const head = execFileSync('git', ['-C', clone, 'rev-parse', 'HEAD'], {
        encoding: 'utf8',
      }).trim();
      return { clone, head };
    }

    // fails-when: the default branch is fetched only into FETCH_HEAD, so it never resolves
    it('new branch: fetches the default branch and diffs the files the branch adds', async () => {
      const { clone, head } = await cloneFeatureOnly();
      try {
        const res = await computeChangedFiles(clone, {
          type: 'push',
          targetBranch: 'feature',
          defaultBranch: 'main',
          payload: { before: '0'.repeat(40), after: head },
        } as unknown as EventPayload);
        expect(res).toEqual({ files: ['src/new.ts'], status: 'fetched' });
      } finally {
        await rm(clone, { recursive: true, force: true });
      }
    });

    // fails-when: a FETCH_HEAD holding HEAD itself is read as the base, giving an empty diff
    it('pull_request: a stale FETCH_HEAD is never mistaken for the base', async () => {
      const { clone, head } = await cloneFeatureOnly();
      try {
        // The clone's own re-fetch of its commit (the SHA-mismatch path) leaves
        // FETCH_HEAD pointing at HEAD.
        execFileSync('git', ['-C', clone, 'fetch', '-q', 'origin', head]);
        const res = await computeChangedFiles(clone, {
          type: 'pull_request',
          baseBranch: 'main',
          targetBranch: 'main',
        } as unknown as EventPayload);
        expect(res).toEqual({ files: ['src/new.ts'], status: 'fetched' });
      } finally {
        await rm(clone, { recursive: true, force: true });
      }
    });
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
      targetBranch: 'main',
      payload: { before: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef', after: 'b'.repeat(40) },
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

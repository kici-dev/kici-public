import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildLocalTriggerRequest, readParentSha } from './local-trigger.js';

describe('buildLocalTriggerRequest', () => {
  it('builds a push webhook request from ref + sha + repo identifier', () => {
    const req = buildLocalTriggerRequest({
      orgId: 'org-1',
      sourceId: 'src-1',
      repoFullName: 'policy/repo',
      event: 'push',
      ref: 'refs/heads/main',
      sha: 'abc123',
      defaultBranch: 'main',
    });
    expect(req.path).toBe('/webhook/org-1/generic/src-1');
    expect(req.headers['x-event-type']).toBe('push');
    expect(req.headers['x-delivery-id']).toBeTruthy();
    const body = JSON.parse(req.body);
    expect(body.ref).toBe('refs/heads/main');
    expect(body.after).toBe('abc123');
    expect(body.repository.full_name).toBe('policy/repo');
    expect(body.repository.default_branch).toBe('main');
  });

  it('produces a distinct delivery id on each call (dedup-safe)', () => {
    const base = {
      orgId: 'o',
      sourceId: 's',
      repoFullName: 'a/b',
      event: 'push' as const,
      ref: 'refs/heads/main',
      sha: 'x',
      defaultBranch: 'main',
    };
    const a = buildLocalTriggerRequest(base);
    const b = buildLocalTriggerRequest(base);
    expect(a.headers['x-delivery-id']).not.toBe(b.headers['x-delivery-id']);
  });
});

describe('before', () => {
  it('puts before in the body when given', () => {
    const req = buildLocalTriggerRequest({
      orgId: 'o',
      sourceId: 's',
      repoFullName: 'r',
      event: 'push',
      ref: 'refs/heads/main',
      sha: 'bbb',
      before: 'aaa',
      defaultBranch: 'main',
    });
    expect(JSON.parse(req.body).before).toBe('aaa');
  });

  // breaks-if-wrong: a trigger with no known parent must stay range-less, never send an empty before
  it('omits before when absent', () => {
    const req = buildLocalTriggerRequest({
      orgId: 'o',
      sourceId: 's',
      repoFullName: 'r',
      event: 'push',
      ref: 'refs/heads/main',
      sha: 'bbb',
      defaultBranch: 'main',
    });
    expect('before' in JSON.parse(req.body)).toBe(false);
  });

  it('readParentSha returns the parent, and undefined for a root commit or a non-repo', () => {
    const repo = mkdtempSync(join(tmpdir(), 'kici-lt-'));
    try {
      const gitCommit = (message: string) =>
        execFileSync(
          'git',
          [
            '-c',
            'user.email=t@t',
            '-c',
            'user.name=t',
            'commit',
            '-q',
            '--allow-empty',
            '-m',
            message,
          ],
          { cwd: repo },
        );
      execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo });
      gitCommit('a');
      const root = execFileSync('git', ['rev-parse', 'HEAD'], {
        cwd: repo,
        encoding: 'utf8',
      }).trim();
      gitCommit('b');
      const head = execFileSync('git', ['rev-parse', 'HEAD'], {
        cwd: repo,
        encoding: 'utf8',
      }).trim();
      expect(readParentSha(repo, head)).toBe(root);
      expect(readParentSha(repo, root)).toBeUndefined();
      expect(readParentSha(join(repo, 'missing'), head)).toBeUndefined();
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});

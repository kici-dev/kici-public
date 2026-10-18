import { describe, it, expect, vi, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { withRepoWrite } from './workflow-runner.js';
import type { GitGrantResponseIpc, RunnerToAgentMessage } from './ipc-protocol.js';

function harness(answer: Partial<GitGrantResponseIpc>) {
  const sent: RunnerToAgentMessage[] = [];
  const send = (msg: RunnerToAgentMessage) => {
    sent.push(msg);
  };
  const wait = async (requestId: string): Promise<GitGrantResponseIpc> => ({
    type: 'git.grant.response',
    requestId,
    ...answer,
  });
  return { sent, send, wait };
}

describe('withRepoWrite', () => {
  it('elevates, runs the callback, then revokes', async () => {
    const { sent, send, wait } = harness({ grantId: 'g1' });
    const order: string[] = [];

    await withRepoWrite(
      'kici-dev/tester',
      { permissions: { contents: 'write' } },
      async () => {
        order.push('callback');
      },
      send,
      wait,
    );

    expect(order).toEqual(['callback']);
    expect(sent.map((m) => (m as { op?: string }).op)).toEqual(['elevate', 'revoke']);
    expect(sent[0]).toMatchObject({
      repository: 'kici-dev/tester',
      permissions: { contents: 'write' },
    });
    expect(sent[1]).toMatchObject({ grantId: 'g1' });
  });

  it('defaults to contents:write when no permissions are named', async () => {
    const { sent, send, wait } = harness({ grantId: 'g1' });
    await withRepoWrite('a/b', {}, async () => {}, send, wait);
    expect(sent[0]).toMatchObject({ permissions: { contents: 'write' } });
  });

  it('forwards a named credential', async () => {
    const { sent, send, wait } = harness({ grantId: 'g1' });
    await withRepoWrite('a/b', { credential: 'forge' }, async () => {}, send, wait);
    expect(sent[0]).toMatchObject({ credentialName: 'forge' });
  });

  it('throws without running the callback when elevation is refused', async () => {
    const { sent, send, wait } = harness({ error: 'the app did not grant workflows=write' });
    const fn = vi.fn();

    await expect(
      withRepoWrite('a/b', { permissions: { workflows: 'write' } }, fn, send, wait),
    ).rejects.toThrow(/workflows=write/);

    expect(fn).not.toHaveBeenCalled();
    // No grant was opened, so nothing must be revoked.
    expect(sent.map((m) => (m as { op?: string }).op)).toEqual(['elevate']);
  });

  it('revokes even when the callback throws', async () => {
    const { sent, send, wait } = harness({ grantId: 'g1' });

    await expect(
      withRepoWrite(
        'a/b',
        {},
        async () => {
          throw new Error('push failed');
        },
        send,
        wait,
      ),
    ).rejects.toThrow('push failed');

    // The window must close even on the throw path, or a failed push would
    // leave write credentials live for the rest of the job.
    expect(sent.map((m) => (m as { op?: string }).op)).toEqual(['elevate', 'revoke']);
  });

  it('fails closed on a timeout rather than proceeding read-only', async () => {
    const { send } = harness({});
    const wait = async (requestId: string): Promise<GitGrantResponseIpc> => ({
      type: 'git.grant.response',
      requestId,
      error: 'timed out waiting for the agent to answer a git write-grant request',
    });
    const fn = vi.fn();
    await expect(withRepoWrite('a/b', {}, fn, send, wait)).rejects.toThrow(/timed out/);
    expect(fn).not.toHaveBeenCalled();
  });

  describe('ssh-key credentials', () => {
    const repos: string[] = [];
    afterEach(() => {
      for (const d of repos.splice(0)) rmSync(d, { recursive: true, force: true });
    });
    const newRepo = (): string => {
      const dir = mkdtempSync(join(tmpdir(), 'kici-repowrite-'));
      execFileSync('git', ['init', '-q', dir]);
      repos.push(dir);
      return dir;
    };
    const sshCommandIn = (repo: string): string | undefined => {
      try {
        return execFileSync('git', ['-C', repo, 'config', '--get', 'core.sshCommand'], {
          encoding: 'utf8',
        }).trim();
      } catch {
        return undefined;
      }
    };

    it('applies the granted ssh command around fn and releases it before revoke', async () => {
      const repo = newRepo();
      const order: string[] = [];
      const sent: RunnerToAgentMessage[] = [];
      const send = (msg: RunnerToAgentMessage) => {
        sent.push(msg);
        if ((msg as { op?: string }).op === 'revoke') {
          order.push(`revoke:${sshCommandIn(repo) ?? 'unset'}`);
        }
      };
      const wait = async (requestId: string): Promise<GitGrantResponseIpc> => ({
        type: 'git.grant.response',
        requestId,
        grantId: 'g',
        granted: { scoped: false },
        sshCommand: 'ssh -i x',
      });

      await withRepoWrite(
        'a/b',
        {},
        async () => {
          order.push(`fn:${sshCommandIn(repo)}`);
        },
        send,
        wait,
        { repoPath: repo, sshCapable: true },
      );

      expect(order).toEqual(['fn:ssh -i x', 'revoke:unset']);
      expect(sshCommandIn(repo)).toBeUndefined();
    });

    it('sends sshCapable only for a host-path runner', async () => {
      const repo = newRepo();
      const host = harness({ grantId: 'g' });
      await withRepoWrite('a/b', {}, async () => {}, host.send, host.wait, {
        repoPath: repo,
        sshCapable: true,
      });
      expect(host.sent[0]).toMatchObject({ sshCapable: true });

      const container = harness({ grantId: 'g' });
      await withRepoWrite('a/b', {}, async () => {}, container.send, container.wait, {
        repoPath: repo,
        sshCapable: false,
      });
      expect(container.sent[0]).not.toHaveProperty('sshCapable');
    });

    it('revokes when the ssh window cannot open', async () => {
      const repo = newRepo();
      const outer = harness({ grantId: 'g1', sshCommand: "ssh -i '/k/a'" });
      const inner = harness({ grantId: 'g2', sshCommand: "ssh -i '/k/b'" });
      const fn = vi.fn();

      await withRepoWrite(
        'a/b',
        {},
        async () => {
          await expect(
            withRepoWrite('a/b', {}, fn, inner.send, inner.wait, {
              repoPath: repo,
              sshCapable: true,
            }),
          ).rejects.toThrow(/different SSH key/);
        },
        outer.send,
        outer.wait,
        { repoPath: repo, sshCapable: true },
      );

      expect(fn).not.toHaveBeenCalled();
      expect(inner.sent.map((m) => (m as { op?: string }).op)).toEqual(['elevate', 'revoke']);
      expect(sshCommandIn(repo)).toBeUndefined();
    });

    it('touches no git config for a token window', async () => {
      const repo = newRepo();
      execFileSync('git', ['-C', repo, 'config', 'core.sshCommand', 'ssh -F /dev/null']);
      const { send, wait } = harness({ grantId: 'g' });
      await withRepoWrite(
        'a/b',
        {},
        async () => {
          expect(sshCommandIn(repo)).toBe('ssh -F /dev/null');
        },
        send,
        wait,
        { repoPath: repo, sshCapable: true },
      );
      expect(sshCommandIn(repo)).toBe('ssh -F /dev/null');
    });
  });
});

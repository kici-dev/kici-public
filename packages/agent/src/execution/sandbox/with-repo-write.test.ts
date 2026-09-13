import { describe, it, expect, vi } from 'vitest';
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
});

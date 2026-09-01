import { describe, it, expect, vi } from 'vitest';
import { buildGitCredentialHandler } from './git-credential-relay.js';

const ownedDispatcher = {
  resolveOwnedJob: vi.fn((_agentId: string, jobId: string) =>
    jobId === 'job-1' ? { runId: 'run-1' } : undefined,
  ),
};

const okContext = async () => ({ orgId: 'org-1', sourceRepo: 'cmaster11/main' });

function handlerWith(broker: { resolve: ReturnType<typeof vi.fn> }) {
  return buildGitCredentialHandler({
    broker: broker as never,
    dispatcher: ownedDispatcher,
    jobContext: okContext,
  });
}

const okResult = { kind: 'basic', secret: 's', grant: { scoped: false }, expiresAt: null };

describe('git credential relay handler', () => {
  it('resolves a workflow-supplied credential for any named repository', async () => {
    const broker = { resolve: vi.fn().mockResolvedValue(okResult) };
    const result = await handlerWith(broker)('agent-1', {
      jobId: 'job-1',
      repositories: ['kici-dev/kici-forge-app-token-tester'],
      ref: {
        kind: 'app',
        appIdSecret: 'ci:A',
        installationIdSecret: 'ci:I',
        privateKeySecret: 'ci:K',
      },
    });

    expect(broker.resolve).toHaveBeenCalledWith(
      expect.objectContaining({
        orgId: 'org-1',
        repositories: ['kici-dev/kici-forge-app-token-tester'],
        runId: 'run-1',
      }),
    );
    expect(result).toMatchObject({ kind: 'basic' });
  });

  it('allows a source-supplied READ of a sibling repo — the shortest path', async () => {
    const broker = { resolve: vi.fn().mockResolvedValue(okResult) };
    // No ref, no permissions => a read with the source credential. Cloning a
    // sibling repo must need no credential in workflow code.
    await handlerWith(broker)('agent-1', {
      jobId: 'job-1',
      repositories: ['cmaster11/shared-lib'],
    });
    expect(broker.resolve).toHaveBeenCalledWith(
      expect.objectContaining({ repositories: ['cmaster11/shared-lib'] }),
    );
  });

  it('refuses a WRITE credential for a repo outside the source org', async () => {
    const broker = { resolve: vi.fn() };
    await expect(
      handlerWith(broker)('agent-1', {
        jobId: 'job-1',
        repositories: ['someone-else/their-repo'],
        permissions: { contents: 'write' },
      }),
    ).rejects.toThrow(/outside the organisation/i);
    expect(broker.resolve).not.toHaveBeenCalled();
  });

  it('allows a WRITE credential inside the source org', async () => {
    const broker = { resolve: vi.fn().mockResolvedValue(okResult) };
    await handlerWith(broker)('agent-1', {
      jobId: 'job-1',
      repositories: ['cmaster11/another-repo'],
      permissions: { contents: 'write' },
    });
    expect(broker.resolve).toHaveBeenCalled();
  });

  it('fences EVERY repository, not just the first', async () => {
    const broker = { resolve: vi.fn() };
    // The in-org repo leads, so a fence that checked only the first entry would
    // wave this through and mint a token covering the out-of-org one too.
    await expect(
      handlerWith(broker)('agent-1', {
        jobId: 'job-1',
        repositories: ['cmaster11/another-repo', 'someone-else/their-repo'],
        permissions: { contents: 'write' },
      }),
    ).rejects.toThrow(/someone-else\/their-repo/);
    expect(broker.resolve).not.toHaveBeenCalled();
  });

  it('forwards every requested repository to the broker', async () => {
    const broker = { resolve: vi.fn().mockResolvedValue(okResult) };
    await handlerWith(broker)('agent-1', {
      jobId: 'job-1',
      repositories: ['cmaster11/one', 'cmaster11/two'],
      permissions: { contents: 'write' },
    });
    expect(broker.resolve).toHaveBeenCalledWith(
      expect.objectContaining({ repositories: ['cmaster11/one', 'cmaster11/two'] }),
    );
  });

  it('rejects a wildcard repository before reaching the broker', async () => {
    const broker = { resolve: vi.fn() };
    await expect(
      handlerWith(broker)('agent-1', { jobId: 'job-1', repositories: ['kici-dev/*'] }),
    ).rejects.toThrow();
    expect(broker.resolve).not.toHaveBeenCalled();
  });

  it('rejects a job the agent does not own', async () => {
    const broker = { resolve: vi.fn() };
    await expect(
      handlerWith(broker)('agent-1', { jobId: 'someone-elses-job', repositories: ['a/b'] }),
    ).rejects.toThrow(/not owned by agent/i);
    expect(broker.resolve).not.toHaveBeenCalled();
  });

  it('rejects an unresolvable job context rather than defaulting to an org', async () => {
    const broker = { resolve: vi.fn() };
    const handler = buildGitCredentialHandler({
      broker: broker as never,
      dispatcher: ownedDispatcher,
      jobContext: async () => null,
    });
    await expect(handler('agent-1', { jobId: 'job-1', repositories: ['a/b'] })).rejects.toThrow(
      /job/i,
    );
    expect(broker.resolve).not.toHaveBeenCalled();
  });

  it('does not leak secret material in a broker failure', async () => {
    const broker = {
      resolve: vi.fn().mockRejectedValue(new Error('boom ghs_supersecrettokenvalue0001')),
    };
    await expect(
      handlerWith(broker)('agent-1', { jobId: 'job-1', repositories: ['cmaster11/main'] }),
    ).rejects.toThrow(/\[REDACTED\]/);
  });

  it('does not leak a private key in a broker failure', async () => {
    const broker = {
      resolve: vi
        .fn()
        .mockRejectedValue(new Error('boom -----BEGIN RSA PRIVATE KEY-----\nMII\n-----END X-----')),
    };
    await expect(
      handlerWith(broker)('agent-1', { jobId: 'job-1', repositories: ['cmaster11/main'] }),
    ).rejects.toThrow(/\[REDACTED_KEY\]/);
  });
});

import { describe, it, expect, vi } from 'vitest';
import { buildGitCredentialHandler, type JobCredentialContext } from './git-credential-relay.js';

const ownedDispatcher = {
  resolveOwnedJob: vi.fn((_agentId: string, jobId: string) =>
    jobId === 'job-1' ? { runId: 'run-1' } : undefined,
  ),
};

/** The app-credential ref the fixture job's lock declares. */
const DECLARED_APP_REF = {
  kind: 'app',
  appIdSecret: 'ci:A',
  installationIdSecret: 'ci:I',
  privateKeySecret: 'ci:K',
} as const;

function jobFacts(overrides: Partial<JobCredentialContext> = {}): JobCredentialContext {
  return {
    orgId: 'org-1',
    sourceRepo: 'cmaster11/main',
    declaredCredentials: { default: { ...DECLARED_APP_REF } },
    trustTier: 'trusted',
    branch: 'main',
    triggerType: 'push',
    ...overrides,
  };
}

function handlerWith(
  broker: { resolve: ReturnType<typeof vi.fn> },
  facts: JobCredentialContext = jobFacts(),
) {
  return buildGitCredentialHandler({
    broker: broker as never,
    dispatcher: ownedDispatcher,
    jobContext: async () => facts,
  });
}

const okResult = { kind: 'basic', secret: 's', grant: { scoped: false }, expiresAt: null };

describe('git credential relay handler', () => {
  it('resolves a lock-declared credential for any named repository', async () => {
    const broker = { resolve: vi.fn().mockResolvedValue(okResult) };
    const result = await handlerWith(broker)('agent-1', {
      jobId: 'job-1',
      repositories: ['kici-dev/kici-forge-app-token-tester'],
      ref: { ...DECLARED_APP_REF },
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
  it("forwards the run's server-truth dispatch facts to the broker gate", async () => {
    const broker = { resolve: vi.fn().mockResolvedValue(okResult) };
    await handlerWith(broker)('agent-1', {
      jobId: 'job-1',
      repositories: ['cmaster11/main'],
      ref: { ...DECLARED_APP_REF },
    });
    expect(broker.resolve).toHaveBeenCalledWith(
      expect.objectContaining({
        gate: {
          dispatchCtx: {
            branch: 'main',
            triggerType: 'push',
            repository: 'cmaster11/main',
            runId: 'run-1',
            jobId: 'job-1',
          },
          trustTier: 'trusted',
        },
      }),
    );
  });

  describe('the lock declaration is the authorization', () => {
    it("refuses a ref the job's lock never declared", async () => {
      const broker = { resolve: vi.fn() };
      await expect(
        handlerWith(broker)('agent-1', {
          jobId: 'job-1',
          repositories: ['cmaster11/main'],
          ref: { kind: 'token', tokenSecret: 'prod:AWS_SECRET_ACCESS_KEY' },
        }),
      ).rejects.toThrow(/not declared by this job's lock/);
      expect(broker.resolve).not.toHaveBeenCalled();
    });

    it('refuses a ref that differs from the declaration in one field', async () => {
      const broker = { resolve: vi.fn() };
      await expect(
        handlerWith(broker)('agent-1', {
          jobId: 'job-1',
          repositories: ['cmaster11/main'],
          ref: { ...DECLARED_APP_REF, privateKeySecret: 'prod:APP_KEY' },
        }),
      ).rejects.toThrow(/not declared by this job's lock/);
      expect(broker.resolve).not.toHaveBeenCalled();
    });

    it('refuses a ref that is a strict SUBSET of a declared entry', async () => {
      // A key-by-key check that never compared key COUNTS would pass this.
      const broker = { resolve: vi.fn() };
      await expect(
        handlerWith(broker)('agent-1', {
          jobId: 'job-1',
          repositories: ['cmaster11/main'],
          ref: { kind: 'token', tokenSecret: 'ci:T' },
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } as any),
      ).rejects.toThrow(/not declared by this job's lock/);
      expect(broker.resolve).not.toHaveBeenCalled();
    });

    it('refuses every ref when the job declared nothing', async () => {
      const broker = { resolve: vi.fn() };
      await expect(
        handlerWith(broker, jobFacts({ declaredCredentials: {} }))('agent-1', {
          jobId: 'job-1',
          repositories: ['cmaster11/main'],
          ref: { ...DECLARED_APP_REF },
        }),
      ).rejects.toThrow(/\(none\)/);
      expect(broker.resolve).not.toHaveBeenCalled();
    });

    it('leaves the no-ref source-credential path untouched when nothing is declared', async () => {
      const broker = { resolve: vi.fn().mockResolvedValue(okResult) };
      await handlerWith(broker, jobFacts({ declaredCredentials: {} }))('agent-1', {
        jobId: 'job-1',
        repositories: ['cmaster11/main'],
      });
      expect(broker.resolve).toHaveBeenCalled();
    });

    it('refuses UNDECLARED inline credential material on the wire', async () => {
      // A `*Value` bypasses the secret store, and therefore the context gate,
      // entirely — so it is admitted only when the lock itself declared it.
      const broker = { resolve: vi.fn() };
      await expect(
        handlerWith(broker, jobFacts({ declaredCredentials: {} }))('agent-1', {
          jobId: 'job-1',
          repositories: ['cmaster11/main'],
          ref: { kind: 'token', tokenValue: 'ghp_forged' },
        }),
      ).rejects.toThrow(/not declared by this job's lock/);
      expect(broker.resolve).not.toHaveBeenCalled();
    });

    it('admits inline material the lock itself declared', async () => {
      // `docs/user/patterns/git-credentials.md` documents a `*Value` entry for a
      // credential that only exists at run time, and the compiler writes it into
      // the lock verbatim. Refusing every `*Value` would break that documented
      // form the moment the declaration channel was turned on. It costs nothing:
      // material the lock declares is already readable from the job's own
      // checkout, and a forger would need it before they could send it.
      const runtimeRef = { kind: 'token', tokenValue: 'from-the-lock' } as const;
      const broker = { resolve: vi.fn().mockResolvedValue(okResult) };
      await handlerWith(broker, jobFacts({ declaredCredentials: { default: { ...runtimeRef } } }))(
        'agent-1',
        {
          jobId: 'job-1',
          repositories: ['cmaster11/main'],
          ref: { ...runtimeRef },
        },
      );
      expect(broker.resolve).toHaveBeenCalled();
    });

    it.each(['unknown', 'known'] as const)(
      'refuses a workflow-supplied ref for the %s tier, before the declaration check',
      async (tier) => {
        const broker = { resolve: vi.fn() };
        await expect(
          handlerWith(broker, jobFacts({ trustTier: tier }))('agent-1', {
            jobId: 'job-1',
            repositories: ['cmaster11/main'],
            ref: { ...DECLARED_APP_REF },
          }),
        ).rejects.toThrow(/contributor tier/);
        expect(broker.resolve).not.toHaveBeenCalled();
      },
    );

    it('still serves the source credential to an untrusted ref', async () => {
      // The fence, not the tier, is what bounds a source-credential read.
      const broker = { resolve: vi.fn().mockResolvedValue(okResult) };
      await handlerWith(broker, jobFacts({ trustTier: 'unknown' }))('agent-1', {
        jobId: 'job-1',
        repositories: ['cmaster11/main'],
      });
      expect(broker.resolve).toHaveBeenCalled();
    });
  });
});

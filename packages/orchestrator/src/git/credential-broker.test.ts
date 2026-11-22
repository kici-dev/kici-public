import { afterEach, describe, it, expect, vi } from 'vitest';
import { stubGithubFetch, TEST_APP_PRIVATE_KEY } from '../__test-helpers__/github-fetch.js';
import { buildGitCredentialHandler } from '../ws/git-credential-relay.js';
import { createJobCredentialContextReader } from './job-context.js';
import {
  GitCredentialBroker,
  GitCredentialRefusedError,
  type BrokerGateContext,
} from './credential-broker.js';

/**
 * A resolver whose every matched context resolves to `values` through its
 * bindings. `legacy` answers the direct lookup of the scope named after the
 * context, which the gate reads when no bound scope carries the key.
 */
const secretResolver = (values: Record<string, string>, legacy?: Record<string, string>) =>
  ({
    resolveForContext: vi.fn(async () => values),
    resolveNamedInternal: vi.fn(
      async (_org: string, _scope: string, key: string) => legacy?.[key] ?? null,
    ),
  }) as never;

const noSource = async () => null;

/**
 * A context store whose every context exists and admits every run, so these
 * tests exercise the broker's own routing rather than the gate's. The gate's
 * own refusals live in `secrets/job-secret-gate.test.ts`.
 */
const permissiveContexts = () =>
  ({
    matchContext: vi.fn(async (orgId: string, name: string) => ({
      id: `ctx-${name}`,
      org_id: orgId,
      name,
      type: 'fixed',
      glob_pattern: null,
      branch_restrictions: null,
      trigger_type_filters: null,
      repo_patterns: null,
      concurrency_limit: null,
      concurrency_strategy: 'queue',
      concurrency_timeout_ms: null,
      required_reviewers: null,
      wait_timer_seconds: null,
      hold_expiry_seconds: null,
      minimum_trust: null,
      allow_local_execution: false,
      enabled: true,
      created_by: null,
      created_at: new Date(),
      updated_at: new Date(),
    })),
  }) as never;

/** The server-truth dispatch facts every job-originated resolve carries. */
const gate: BrokerGateContext = {
  dispatchCtx: {
    branch: 'main',
    triggerType: 'push',
    repository: 'acme/app',
    runId: 'run-1',
    jobId: 'job-1',
  },
  trustTier: 'trusted',
};

describe('GitCredentialBroker', () => {
  it('returns a static token unscoped — a PAT cannot be narrowed', async () => {
    const broker = new GitCredentialBroker({
      secretResolver: secretResolver({ FORGE_PAT: 'pat-value' }),
      contextStore: permissiveContexts(),
      sourceAuth: noSource,
      mint: vi.fn(),
    });
    const result = await broker.resolve({
      orgId: 'org-1',
      gate,
      repositories: ['acme/app'],
      ref: { kind: 'token', tokenSecret: 'ci:FORGE_PAT', user: 'oauth2' },
      permissions: { contents: 'read' },
    });

    expect(result.kind).toBe('basic');
    expect(result.user).toBe('oauth2');
    expect(result.secret).toBe('pat-value');
    // Requested contents:read, but nothing was actually enforced. Say so.
    expect(result.grant).toEqual({ scoped: false });
    expect(result.expiresAt).toBeNull();
  });

  it('resolves the secret against the context named in the qualified ref', async () => {
    const resolver = secretResolver({ FORGE_PAT: 'pat-value' });
    const broker = new GitCredentialBroker({
      secretResolver: resolver,
      contextStore: permissiveContexts(),
      sourceAuth: noSource,
      mint: vi.fn(),
    });
    await broker.resolve({
      orgId: 'org-1',
      gate,
      repositories: ['acme/app'],
      ref: { kind: 'token', tokenSecret: 'prod:FORGE_PAT' },
    });
    expect(
      (resolver as unknown as { resolveForContext: ReturnType<typeof vi.fn> }).resolveForContext,
    ).toHaveBeenCalledWith('org-1', { id: 'ctx-prod', name: 'prod' }, undefined, expect.anything());
  });

  it('returns runtime material verbatim through the *Value half', async () => {
    const resolver = secretResolver({});
    const broker = new GitCredentialBroker({
      secretResolver: resolver,
      contextStore: permissiveContexts(),
      sourceAuth: noSource,
      mint: vi.fn(),
    });
    const result = await broker.resolve({
      orgId: 'org-1',
      gate,
      repositories: ['acme/app'],
      ref: { kind: 'token', tokenValue: 'runtime-material' },
    });
    expect(result.secret).toBe('runtime-material');
    // No secret-store lookup happens for material.
    expect(
      (resolver as unknown as { resolveForContext: ReturnType<typeof vi.fn> }).resolveForContext,
    ).not.toHaveBeenCalled();
  });

  it('returns an ssh key as kind ssh, unscoped and non-expiring', async () => {
    const broker = new GitCredentialBroker({
      secretResolver: secretResolver({ DEPLOY_KEY: '-----BEGIN PRIVATE KEY-----' }),
      contextStore: permissiveContexts(),
      sourceAuth: noSource,
      mint: vi.fn(),
    });
    const result = await broker.resolve({
      orgId: 'org-1',
      gate,
      repositories: ['acme/app'],
      ref: { kind: 'ssh', privateKeySecret: 'ci:DEPLOY_KEY' },
    });
    expect(result.kind).toBe('ssh');
    expect(result.grant).toEqual({ scoped: false });
    expect(result.expiresAt).toBeNull();
  });

  it('mints an app credential and reports the granted permissions', async () => {
    const mint = vi.fn().mockResolvedValue({
      token: 'ghs_x',
      expiresAt: '2026-08-22T05:51:29Z',
      grantedPermissions: { contents: 'write', workflows: 'write' },
      repositorySelection: 'selected',
    });
    const broker = new GitCredentialBroker({
      secretResolver: secretResolver({ APP_ID: '11', INSTALL_ID: '22', APP_KEY: 'pem' }),
      contextStore: permissiveContexts(),
      sourceAuth: noSource,
      mint,
    });
    const result = await broker.resolve({
      orgId: 'org-1',
      gate,
      repositories: ['kici-dev/kici-forge-app-token-tester'],
      ref: {
        kind: 'app',
        appIdSecret: 'ci:APP_ID',
        installationIdSecret: 'ci:INSTALL_ID',
        privateKeySecret: 'ci:APP_KEY',
      },
      permissions: { contents: 'write', workflows: 'write' },
    });

    expect(mint).toHaveBeenCalledWith(
      expect.objectContaining({ appId: '11', installationId: '22', privateKey: 'pem' }),
    );
    expect(result.kind).toBe('basic');
    expect(result.user).toBe('x-access-token');
    expect(result.grant).toEqual({
      scoped: true,
      permissions: { contents: 'write', workflows: 'write' },
    });
    expect(result.expiresAt).toBe('2026-08-22T05:51:29Z');
  });

  describe("an app ref mints at its job's GitHub server", () => {
    const APP_REF = {
      kind: 'app',
      appIdSecret: 'ci:APP_ID',
      installationIdSecret: 'ci:INSTALL_ID',
      privateKeySecret: 'ci:APP_KEY',
    } as const;

    afterEach(() => {
      vi.unstubAllGlobals();
    });

    function brokerWith(
      mint?: ConstructorParameters<typeof GitCredentialBroker>[0]['mint'],
      privateKey = 'pem',
    ) {
      return new GitCredentialBroker({
        secretResolver: secretResolver({ APP_ID: '11', INSTALL_ID: '22', APP_KEY: privateKey }),
        contextStore: permissiveContexts(),
        sourceAuth: noSource,
        ...(mint ? { mint } : {}),
      });
    }

    const resolveArgs = (githubUrl?: string) => ({
      orgId: 'org-1',
      gate,
      repositories: ['acme/app'],
      ref: { ...APP_REF },
      permissions: { contents: 'read' },
      ...(githubUrl ? { githubUrl } : {}),
    });

    const minted = {
      token: 'ghs_x',
      expiresAt: null,
      grantedPermissions: { contents: 'read' },
      repositorySelection: 'selected',
    };

    it("an app ref mints at the job's GitHub server", async () => {
      const mint = vi.fn().mockResolvedValue(minted);
      await brokerWith(mint).resolve(resolveArgs('https://ghe.corp.example'));
      // fails-when: the broker drops the job's server, so the mint targets api.github.com
      expect(mint.mock.calls[0]![0]).toMatchObject({ githubUrl: 'https://ghe.corp.example' });
    });

    it('an app ref of a github.com job mints with no server', async () => {
      const mint = vi.fn().mockResolvedValue(minted);
      await brokerWith(mint).resolve(resolveArgs());
      // breaks-if-wrong: a github.com or non-GitHub job keeps minting at github.com
      expect(mint.mock.calls[0]![0]).not.toHaveProperty('githubUrl');
    });

    it('the default mint posts the token request to that server', async () => {
      const requests = stubGithubFetch();
      await brokerWith(undefined, TEST_APP_PRIVATE_KEY).resolve(
        resolveArgs('https://ghe.corp.example'),
      );
      // fails-when: the production mint path ignores the job's server
      expect(requests.map((r) => `${r.method} ${r.url}`)).toEqual([
        'POST https://ghe.corp.example/api/v3/app/installations/22/access_tokens',
      ]);

      const dotcom = stubGithubFetch();
      await brokerWith(undefined, TEST_APP_PRIVATE_KEY).resolve(resolveArgs());
      // breaks-if-wrong: a job with no server still mints at api.github.com
      expect(dotcom.map((r) => `${r.method} ${r.url}`)).toEqual([
        'POST https://api.github.com/app/installations/22/access_tokens',
      ]);
    });

    describe('through the relay, from the rows the orchestrator wrote', () => {
      const JOB_ID = '3f9b6c02-3a1f-4c19-9a2f-6b0d1e7c4a55';
      /** The provider context a routing-key-scoped token set on a manual registration. */
      const INJECTED = { installationId: 22, githubUrl: 'https://evil.example' };

      /** A db holding a cron run of `routingKey`'s source and the `sources` rows given. */
      function runDb(routingKey: string, sources: Record<string, { github_url: string | null }>) {
        const answer = (table: string, where: Record<string, unknown>) => {
          if (table === 'execution_runs') {
            return {
              customer_id: 'org-1',
              repo_identifier: 'acme/app',
              ref: 'main',
              trigger_event: 'schedule',
              trust_tier: null,
              workflow_repo_identifier: null,
              workflow_branch: null,
              routing_key: routingKey,
              dispatch_routing_key: null,
              provider_context: INJECTED,
            };
          }
          if (table === 'execution_jobs') return { git_credentials: { ghes: { ...APP_REF } } };
          if (table === 'dispatch_queue') {
            return {
              job_config: '{}',
              repo_url: 'https://h/acme/app.git',
              routing_key: routingKey,
            };
          }
          return sources[where.routing_key as string];
        };
        return {
          selectFrom: (table: string) => {
            const where: Record<string, unknown> = {};
            const chain = {
              select: () => chain,
              where: (column: string, _op: string, value: unknown) => {
                where[column] = value;
                return chain;
              },
              executeTakeFirst: async () => answer(table, where),
            };
            return chain;
          },
        } as never;
      }

      const mintThroughRelay = (db: never) =>
        buildGitCredentialHandler({
          broker: brokerWith(undefined, TEST_APP_PRIVATE_KEY),
          dispatcher: { resolveOwnedJob: () => ({ runId: 'run-1' }) },
          jobContext: createJobCredentialContextReader(db),
        })('agent-1', { jobId: JOB_ID, repositories: ['acme/app'], ref: { ...APP_REF } });

      it("an injected server never receives the App's JWT: the source's own server does", async () => {
        const ghes = stubGithubFetch();
        await mintThroughRelay(
          runDb('github:7', {
            'github:7': { github_url: 'https://ghe.corp.example' },
          }),
        );
        // fails-when: the injected host wins and the JWT goes to https://evil.example
        expect(ghes.map((r) => `${r.method} ${r.url}`)).toEqual([
          'POST https://ghe.corp.example/api/v3/app/installations/22/access_tokens',
        ]);

        const dotcom = stubGithubFetch();
        await mintThroughRelay(runDb('github:1', { 'github:1': { github_url: null } }));
        // fails-when: a github.com source's job is redirected by its provider context
        expect(dotcom.map((r) => `${r.method} ${r.url}`)).toEqual([
          'POST https://api.github.com/app/installations/22/access_tokens',
        ]);
      });

      it('a job of a removed GitHub source is refused and sends nothing', async () => {
        const requests = stubGithubFetch();
        await expect(mintThroughRelay(runDb('github:7', {}))).rejects.toThrow(
          /github:7 that ran this job is no longer configured/,
        );
        // fails-when: the mint falls back to the stamp or to api.github.com
        expect(requests).toEqual([]);
      });
    });
  });

  it('reports a narrower grant rather than the request', async () => {
    const mint = vi.fn().mockResolvedValue({
      token: 'ghs_x',
      expiresAt: null,
      grantedPermissions: { contents: 'read' },
      repositorySelection: 'selected',
    });
    const broker = new GitCredentialBroker({
      secretResolver: secretResolver({ APP_ID: '11', INSTALL_ID: '22', APP_KEY: 'pem' }),
      contextStore: permissiveContexts(),
      sourceAuth: noSource,
      mint,
    });
    const result = await broker.resolve({
      orgId: 'org-1',
      gate,
      repositories: ['a/b'],
      ref: {
        kind: 'app',
        appIdSecret: 'ci:APP_ID',
        installationIdSecret: 'ci:INSTALL_ID',
        privateKeySecret: 'ci:APP_KEY',
      },
      permissions: { contents: 'write' },
    });
    expect(result.grant).toEqual({ scoped: true, permissions: { contents: 'read' } });
  });

  it('throws naming the missing secret, not a generic failure', async () => {
    const broker = new GitCredentialBroker({
      secretResolver: secretResolver({}),
      contextStore: permissiveContexts(),
      sourceAuth: noSource,
      mint: vi.fn(),
    });
    await expect(
      broker.resolve({
        orgId: 'org-1',
        gate,
        repositories: ['a/b'],
        ref: { kind: 'token', tokenSecret: 'ci:MISSING_PAT' },
      }),
    ).rejects.toThrow(/MISSING_PAT/);
  });

  it("refuses a token held only in an unbound exact context's same-named scope", async () => {
    const resolver = secretResolver({}, { FORGE_PAT: 'same-named-pat' });
    const broker = new GitCredentialBroker({
      secretResolver: resolver,
      contextStore: permissiveContexts(),
      sourceAuth: noSource,
      mint: vi.fn(),
    });
    // fails-when: the gate still reads the scope named after the context
    await expect(
      broker.resolve({
        orgId: 'org-1',
        gate,
        repositories: ['a/b'],
        ref: { kind: 'token', tokenSecret: 'ci:FORGE_PAT' },
        runId: 'run-1',
        jobId: 'job-1',
      }),
    ).rejects.toThrow(/FORGE_PAT/);
    expect(
      (resolver as unknown as { resolveNamedInternal: ReturnType<typeof vi.fn> })
        .resolveNamedInternal,
    ).not.toHaveBeenCalled();
  });

  it('falls back to the source credential when no ref is supplied', async () => {
    const broker = new GitCredentialBroker({
      secretResolver: secretResolver({}),
      contextStore: permissiveContexts(),
      sourceAuth: async () => ({ kind: 'basic' as const, user: 'x-access-token', secret: 'src' }),
      mint: vi.fn(),
    });
    const result = await broker.resolve({ orgId: 'org-1', gate, repositories: ['a/b'] });
    expect(result.secret).toBe('src');
    expect(result.grant).toEqual({ scoped: false });
  });

  it('throws actionably when no source credential is configured', async () => {
    const broker = new GitCredentialBroker({
      secretResolver: secretResolver({}),
      contextStore: permissiveContexts(),
      sourceAuth: noSource,
      mint: vi.fn(),
    });
    const err = await broker
      .resolve({ orgId: 'org-1', gate, repositories: ['a/b'] })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GitCredentialRefusedError);
    expect((err as Error).message).toMatch(/No source credential is configured for 'a\/b'/);
  });

  it('refuses a malformed or incomplete reference as a typed refusal', async () => {
    // fails-when: a request-derived refusal is a plain Error, which the relay
    // turns into the fixed internal error.
    const broker = new GitCredentialBroker({
      secretResolver: secretResolver({}),
      contextStore: permissiveContexts(),
      sourceAuth: noSource,
      mint: vi.fn(),
    });
    for (const ref of [
      { kind: 'token' as const, tokenSecret: 'no-colon' },
      { kind: 'token' as const },
    ]) {
      const err = await broker
        .resolve({ orgId: 'org-1', gate, repositories: ['a/b'], ref: ref as never })
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(GitCredentialRefusedError);
    }
  });

  it('keeps a mint failure a plain error', async () => {
    // breaks-if-wrong: an infrastructure failure must never read as a refusal.
    const broker = new GitCredentialBroker({
      secretResolver: secretResolver({}),
      contextStore: permissiveContexts(),
      sourceAuth: noSource,
      mint: vi.fn().mockRejectedValue(new Error('GitHub 502')),
    });
    const err = await broker
      .resolve({
        orgId: 'org-1',
        gate,
        repositories: ['a/b'],
        ref: { kind: 'app', appIdValue: '1', installationIdValue: '2', privateKeyValue: 'k' },
      })
      .catch((e: unknown) => e);
    expect(err).not.toBeInstanceOf(GitCredentialRefusedError);
  });

  it("refuses a reference into the orchestrator's own reserved namespace", async () => {
    // A job's orgId is its customer_id, so `__source__/…` misses today by
    // accident. The gate makes it a stated refusal instead.
    const resolver = secretResolver({ privateKey: 'app-pem' });
    const broker = new GitCredentialBroker({
      secretResolver: resolver,
      contextStore: permissiveContexts(),
      sourceAuth: noSource,
      mint: vi.fn(),
    });
    await expect(
      broker.resolve({
        orgId: 'org-1',
        gate,
        repositories: ['a/b'],
        ref: { kind: 'ssh', privateKeySecret: '__source__/src-1:privateKey' },
      }),
    ).rejects.toThrow(/reserved/);
    expect(
      (resolver as unknown as { resolveForContext: ReturnType<typeof vi.fn> }).resolveForContext,
    ).not.toHaveBeenCalled();
  });

  it('refuses a qualified reference for an untrusted contributor', async () => {
    const resolver = secretResolver({ FORGE_PAT: 'pat-value' });
    const broker = new GitCredentialBroker({
      secretResolver: resolver,
      contextStore: permissiveContexts(),
      sourceAuth: noSource,
      mint: vi.fn(),
    });
    await expect(
      broker.resolve({
        orgId: 'org-1',
        gate: { ...gate, trustTier: 'unknown' },
        repositories: ['a/b'],
        ref: { kind: 'token', tokenSecret: 'ci:FORGE_PAT' },
      }),
    ).rejects.toThrow(/contributor tier/);
  });

  describe('the reserved needs: context', () => {
    it('resolves a secret output inherited from an upstream job', async () => {
      const broker = new GitCredentialBroker({
        secretResolver: secretResolver({}),
        contextStore: permissiveContexts(),
        sourceAuth: noSource,
        mint: vi.fn(),
        secretOutputs: async (_runId, _jobId, key) =>
          key === 'FORGE_TOKEN' ? 'inherited-token' : null,
      });
      const result = await broker.resolve({
        orgId: 'org-1',
        gate,
        repositories: ['a/b'],
        ref: { kind: 'token', tokenSecret: 'needs:FORGE_TOKEN' },
        runId: 'run-1',
        jobId: 'job-2',
      });
      expect(result.secret).toBe('inherited-token');
    });

    it('names the producing job requirement when the output is absent', async () => {
      const broker = new GitCredentialBroker({
        secretResolver: secretResolver({}),
        contextStore: permissiveContexts(),
        sourceAuth: noSource,
        mint: vi.fn(),
        secretOutputs: async () => null,
      });
      const err = await broker
        .resolve({
          orgId: 'org-1',
          gate,
          repositories: ['a/b'],
          ref: { kind: 'token', tokenSecret: 'needs:ABSENT' },
          runId: 'run-1',
          jobId: 'job-2',
        })
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(GitCredentialRefusedError);
      expect((err as Error).message).toMatch(/setSecretOutput\('ABSENT'/);
    });

    it('does not reach the ordinary secret store for a needs: reference', async () => {
      const resolver = secretResolver({ FORGE_TOKEN: 'wrong-source' });
      const broker = new GitCredentialBroker({
        secretResolver: resolver,
        contextStore: permissiveContexts(),
        sourceAuth: noSource,
        mint: vi.fn(),
        secretOutputs: async () => 'right-source',
      });
      const result = await broker.resolve({
        orgId: 'org-1',
        gate,
        repositories: ['a/b'],
        ref: { kind: 'token', tokenSecret: 'needs:FORGE_TOKEN' },
        runId: 'run-1',
        jobId: 'job-2',
      });
      expect(result.secret).toBe('right-source');
      expect(
        (resolver as unknown as { resolveForContext: ReturnType<typeof vi.fn> }).resolveForContext,
      ).not.toHaveBeenCalled();
    });
  });
});

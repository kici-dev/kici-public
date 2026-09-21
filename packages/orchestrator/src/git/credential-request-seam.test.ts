/**
 * The `git.credential.request` seam, end to end inside the orchestrator.
 *
 * The relay, the job-context reader, the broker and the job secret gate are all
 * the real implementations here; only the database rows, the context store and
 * the secret backend are doubles. That is the seam the E2E
 * `secrets-pipeline` git-credential-relay block exercises against a deployed
 * stack, and the piece the per-module unit tests each stub out: the relay's own
 * suite hands the handler a fixed `jobContext`, so no test drove a real reader
 * into a real gate, and a legitimate request could be refused with every module
 * passing its own tests.
 *
 * The fixture pins the ordering that broke it: the job's `execution_jobs` row is
 * ABSENT, because the pipeline sends the dispatch and persists the tracked row
 * afterwards. Every refusal below runs against that same fixture, so an admit
 * that only works once the row lands cannot hide behind them.
 */
import { describe, expect, it, vi } from 'vitest';
import { GitCredentialBroker } from './credential-broker.js';
import { createJobCredentialContextReader } from './job-context.js';
import type { ContextStore } from '../contexts/context-store.js';
import type { SecretResolverApi } from '../secrets/secret-resolver.js';
import { buildGitCredentialHandler } from '../ws/git-credential-relay.js';

const ORG = 'org-1';
const RUN_ID = 'run-1';
const JOB_ID = '3f9b6c02-3a1f-4c19-9a2f-6b0d1e7c4a55';
const SEEDED = 'the-seeded-token';

/** The lock's declaration, verbatim — what the dispatch record carries. */
const DECLARED = {
  default: { kind: 'token', tokenSecret: 'ci:GITCRED_TOKEN' },
  locked: { kind: 'token', tokenSecret: 'locked:GITCRED_TOKEN' },
};

/** A `contexts` row as the store returns it. Only the gate-relevant fields matter. */
function contextRow(name: string, overrides: Record<string, unknown> = {}) {
  return {
    id: `ctx-${name}`,
    org_id: ORG,
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
    ...overrides,
  };
}

/**
 * `ci` admits any branch; `locked` restricts to a branch this run cannot
 * present — the same pair the E2E block seeds.
 */
const contextStore = {
  matchContext: vi.fn(async (_orgId: string, name: string) => {
    if (name === 'ci') return contextRow('ci');
    if (name === 'locked') {
      return contextRow('locked', {
        branch_restrictions: JSON.stringify(['refs/heads/no-such-branch']),
      });
    }
    return null;
  }),
} as unknown as ContextStore;

const secretResolver = {
  resolveForJob: vi.fn(),
  resolveForJobWithMeta: vi.fn(),
  resolveNamedInternal: vi.fn(async (_org: string, context: string, key: string) =>
    key === 'GITCRED_TOKEN' && (context === 'ci' || context === 'locked') ? SEEDED : null,
  ),
} as unknown as SecretResolverApi;

/** The run row exists; the job row does not yet. The dispatch record does. */
function raceWindowDb() {
  const rows: Record<string, unknown> = {
    execution_runs: {
      customer_id: ORG,
      repo_identifier: 'acme/main',
      ref: 'master',
      trigger_event: 'push',
      trust_tier: null,
    },
    execution_jobs: undefined,
    dispatch_queue: { job_config: JSON.stringify({ gitCredentials: DECLARED }) },
  };
  return {
    selectFrom: (table: string) => {
      const chain = {
        select: () => chain,
        where: () => chain,
        executeTakeFirst: async () => rows[table],
      };
      return chain;
    },
  } as never;
}

function handler() {
  return buildGitCredentialHandler({
    broker: new GitCredentialBroker({
      secretResolver,
      contextStore,
      sourceAuth: async () => null,
    }),
    dispatcher: {
      resolveOwnedJob: (_agentId: string, jobId: string) =>
        jobId === JOB_ID ? { runId: RUN_ID } : undefined,
    },
    jobContext: createJobCredentialContextReader(raceWindowDb()),
  });
}

const request = (params: Record<string, unknown>) => handler()('agent-1', params);

describe('git.credential.request, relay through gate', () => {
  it('resolves a declared ref before the tracked job row lands', async () => {
    await expect(
      request({
        jobId: JOB_ID,
        repositories: ['acme/main'],
        ref: { kind: 'token', tokenSecret: 'ci:GITCRED_TOKEN' },
      }),
    ).resolves.toMatchObject({ kind: 'basic', secret: SEEDED });
  });

  it('refuses a ref the job never declared', async () => {
    await expect(
      request({
        jobId: JOB_ID,
        repositories: ['acme/main'],
        ref: { kind: 'token', tokenSecret: 'ci:DB_PASSWORD' },
      }),
    ).rejects.toThrow(/not declared/);
  });

  it('refuses undeclared inline credential material', async () => {
    await expect(
      request({
        jobId: JOB_ID,
        repositories: ['acme/main'],
        ref: { kind: 'token', tokenValue: 'ghp_forged_material_0000000000' },
      }),
    ).rejects.toThrow(/not declared/);
  });

  it("refuses a declared ref whose named context's protection rule rejects", async () => {
    await expect(
      request({
        jobId: JOB_ID,
        repositories: ['acme/main'],
        ref: { kind: 'token', tokenSecret: 'locked:GITCRED_TOKEN' },
      }),
    ).rejects.toThrow(/does not admit this run/);
  });

  it('refuses a request for a job this agent was never dispatched', async () => {
    await expect(
      request({ jobId: 'someone-elses-job', repositories: ['acme/main'] }),
    ).rejects.toThrow(/not owned by agent/);
  });
});

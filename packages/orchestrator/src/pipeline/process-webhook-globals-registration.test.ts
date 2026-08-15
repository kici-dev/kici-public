/**
 * A global workflow the org policy refuses to register says so, by name.
 *
 * The defect this suite guards: a default-branch push whose lock file declares
 * global workflows had every one of them silently stripped from the
 * registration set whenever `isWorkflowRepoAllowed` denied. The only record was
 * a `logger.warn` naming the reason and the repo — not the workflows, and not
 * the org the policy had actually decided against. That matters because the
 * denial commonly comes from the `'__default__'` org anchor, which no operator
 * ever configured and which the reason string ("global workflows not enabled
 * for this organization") describes as if it were the org they DID configure.
 *
 * The failure this produces is remote from its cause in both space and time:
 * the exclusion happens on the AUTHORING repo's push, and what gets
 * investigated is a cross-repo event, days later, that dispatched nothing. With
 * no registration row and no run, "the global was refused registration" and
 * "this repo declares no globals" are byte-identical from every side.
 *
 * `registerWorkflowsOnDefaultBranchPush` is module-private, so it is driven
 * end-to-end through `processWebhook` — the same reason the sibling globals
 * suites do it that way, and here it additionally exercises the default-branch
 * gate that decides whether registration is attempted at all.
 */
import { describe, it, expect, vi } from 'vitest';
import { processWebhook } from './process-webhook.js';
import type { WebhookInfo } from '../webhook/handler.js';

const WORKFLOW_REPO = 'acme/org-workflows';
const GLOBAL_WORKFLOW = 'org-ci';
const PER_REPO_WORKFLOW = 'repo-ci';
const ROUTING_KEY = 'github:1';
/** The plane's no-tenant anchor — what `resolveOrgId` reports for an unmapped source. */
const DEFAULT_ORG = '__default__';
const REAL_ORG = 'org_kiciStg00001';

function makeInfo(): WebhookInfo {
  return {
    routingKey: ROUTING_KEY,
    deliveryId: `d-${Math.random().toString(36).slice(2)}`,
    event: 'push',
    provider: 'github',
    payload: { repository: { full_name: WORKFLOW_REPO, default_branch: 'master' } },
  } as unknown as WebhookInfo;
}

/** A push-triggered workflow. `repos` is what makes it global. */
function workflow(name: string, repos?: Array<{ type: 'glob'; pattern: string }>) {
  return {
    name,
    contentHash: `${name}-hash`,
    compileSchemaVersion: 1,
    triggers: [
      {
        _type: 'push',
        branches: [],
        paths: [],
        ...(repos === undefined ? {} : { repos }),
      },
    ],
    jobs: [],
  };
}

interface ExclusionLine {
  deliveryId: string;
  workflowRepo: string;
  routingKey: string;
  orgId: string;
  reason: string;
  excludedCount: number;
  excluded: string[];
  remedy: string;
}

/**
 * Capture the orchestrator's own log lines for the duration of a call.
 *
 * Winston's Console transport writes to `console._stdout` when Node exposes it
 * and to `process.stdout` otherwise, so both are covered — spying on
 * `process.stdout` alone silently records nothing under vitest and the
 * assertion reads as "the line was never emitted".
 */
function captureLogLines() {
  const lines: string[] = [];
  const stream = (console as unknown as { _stdout?: NodeJS.WriteStream })._stdout ?? process.stdout;
  const write = vi.spyOn(stream, 'write').mockImplementation((chunk: unknown): boolean => {
    lines.push(String(chunk));
    return true;
  });
  const MESSAGE = 'Global workflows excluded from registration';
  const LOOKUP_FAILED = 'Org lookup failed';
  return {
    restore: () => write.mockRestore(),
    count: () => lines.filter((l) => l.includes(MESSAGE)).length,
    /** The exclusion line, parsed. Throws (failing the test) when absent. */
    find(): ExclusionLine {
      const line = lines.find((l) => l.includes(MESSAGE));
      if (line === undefined) {
        throw new Error(`no exclusion line emitted; saw ${lines.length} log line(s)`);
      }
      return JSON.parse(line) as ExclusionLine;
    },
    /** The org-lookup-failure line, parsed. Throws (failing) when absent. */
    findLookupFailure(): { routingKey: string; error: string } {
      const line = lines.find((l) => l.includes(LOOKUP_FAILED));
      if (line === undefined) {
        throw new Error(`no org-lookup-failure line emitted; saw ${lines.length} log line(s)`);
      }
      return JSON.parse(line) as { routingKey: string; error: string };
    },
    countLookupFailures: () => lines.filter((l) => l.includes(LOOKUP_FAILED)).length,
  };
}

interface Harness {
  deps: Parameters<typeof processWebhook>[1];
  /** Workflow names actually handed to `registrationStore.replaceAll`. */
  registered: () => string[];
  /** The `globalWorkflowNames` set the store was told to mark. */
  markedGlobal: () => string[];
  isWorkflowRepoAllowed: ReturnType<typeof vi.fn>;
}

/**
 * Deps that reach the registration path: a default-branch push whose lock file
 * resolves and declares one global plus one ordinary workflow.
 *
 * The two-workflow shape is load-bearing: the exclusion must remove the global
 * and leave the per-repo workflow registered, and a single-workflow fixture
 * cannot tell "dropped the globals" from "dropped everything".
 */
function makeDeps(over: { allowed: boolean; orgId?: string; reason?: string }): Harness {
  const orgId = over.orgId ?? DEFAULT_ORG;
  const isWorkflowRepoAllowed = vi.fn(async () => ({
    allowed: over.allowed,
    ...(over.allowed
      ? {}
      : { reason: over.reason ?? 'Global workflows not enabled for this organization' }),
  }));
  const replaceAll = vi.fn(async () => undefined);

  const bundle = {
    normalizer: {
      provider: 'github',
      normalizeEvent: () => ({
        type: 'push',
        payload: {},
        targetBranch: 'master',
        sourceBranch: 'master',
        senderUsername: 'octocat',
        provider: 'github',
      }),
      extractRef: () => 'headsha',
      extractRepoIdentifier: () => WORKFLOW_REPO,
      extractCredentials: () => ({ token: 'src-token' }),
      isDefaultBranchPush: () => true,
    },
    checkStatusPoster: {
      provider: 'github',
      postCheckStatus: vi.fn(),
      postGlobalWorkflowsSkippedCheck: vi.fn(),
      postGlobalEvalFailedCheck: vi.fn(),
    },
    lockFileFetcher: { fetchLockFile: vi.fn() },
    repoUrlBuilder: { buildCloneUrl: (repo: string) => `https://example.invalid/${repo}.git` },
  };

  const deps = {
    dedup: { claim: vi.fn(async () => true), exists: vi.fn(), mark: vi.fn(), cleanup: vi.fn() },
    providerRegistry: { getByRoutingKey: () => bundle, getAll: () => [] },
    orchestratorMode: 'platform',
    db: {},
    resolveOrgIdOverride: undefined,
    registrationStore: { replaceAll, bumpVersion: vi.fn(async () => 7) },
    registrationIndex: {
      refreshIfNeeded: vi.fn(async () => undefined),
      getGlobalByOrgAndTriggerType: () => [],
      getByRepo: () => [],
      getByOrgAndEvent: () => [],
    },
    globalWorkflowPolicy: {
      isWorkflowRepoAllowed,
      isSourceRepoAllowed: vi.fn(async () => ({ allowed: true })),
      isElevatedAccessAllowed: vi.fn(async () => false),
    },
    dispatcher: { dispatch: vi.fn(async () => ({ status: 'queued', jobId: 'j1' })) },
    lockFileCache: {
      get: vi.fn(async () => ({
        schemaVersion: 34,
        source: { file: '.kici/workflows/ci.ts', export: '#default' },
        contentHash: 'srchash',
        workflows: [
          workflow(GLOBAL_WORKFLOW, [{ type: 'glob', pattern: '**' }]),
          workflow(PER_REPO_WORKFLOW),
        ],
      })),
    },
  } as unknown as Parameters<typeof processWebhook>[1];

  // `resolveOrgId` reads the `sources` table; stub the whole lookup so the org
  // under test is the one the policy sees.
  (deps as unknown as { db: unknown }).db = {
    selectFrom: () => ({
      select: () => ({
        where: () => ({ executeTakeFirst: async () => ({ customer_id: orgId }) }),
      }),
    }),
  };

  return {
    deps,
    registered: () =>
      (replaceAll.mock.calls[0]?.[1] as Array<{ name: string }> | undefined)?.map((w) => w.name) ??
      [],
    // `replaceAll(repoIdentifier, workflows, routingKey, credentials, options)`
    markedGlobal: () => [
      ...((replaceAll.mock.calls[0]?.[4] as { globalWorkflowNames?: Set<string> } | undefined)
        ?.globalWorkflowNames ?? new Set<string>()),
    ],
    isWorkflowRepoAllowed,
  };
}

describe('a global workflow refused registration says which workflows and which org', () => {
  it('names every excluded workflow and the org the policy decided against', async () => {
    const lines = captureLogLines();
    let h!: Harness;
    try {
      h = makeDeps({ allowed: false });
      await processWebhook(makeInfo(), h.deps);
    } finally {
      lines.restore();
    }

    // The exclusion really happened: the global is gone from the registration
    // set and the per-repo workflow survived. Without this the log assertions
    // below could pass over a delivery that registered everything.
    expect(h.registered()).toEqual([PER_REPO_WORKFLOW]);
    expect(h.markedGlobal()).toEqual([]);

    const line = lines.find();
    expect(
      line.excluded,
      'the line does not name the excluded workflow, so "refused" is still indistinguishable ' +
        'from "this repo declares no globals"',
    ).toEqual([GLOBAL_WORKFLOW]);
    expect(line.excludedCount).toBe(1);
    expect(line.workflowRepo).toBe(WORKFLOW_REPO);
    expect(line.routingKey).toBe(ROUTING_KEY);
    // The datum the old line lacked entirely, and the one that identifies the
    // cause: the policy read `org_settings` for an org nobody configured.
    expect(
      line.orgId,
      'the line does not carry the org, so a denial under the no-tenant anchor reads as a ' +
        'denial by the org the operator actually configured',
    ).toBe(DEFAULT_ORG);
    expect(line.reason).toContain('not enabled');
  });

  it('spells out the mapping remedy when the org resolved to the no-tenant anchor', async () => {
    const lines = captureLogLines();
    try {
      await processWebhook(makeInfo(), makeDeps({ allowed: false }).deps);
    } finally {
      lines.restore();
    }

    const { remedy } = lines.find();
    // Both the mapping remedy (map the unmapped source) and the fleet-switch
    // remedy — only the operator knows whether the missing mapping is the real
    // problem. The master switch is fleet-wide now, so the anchor has no
    // per-org opt-in of its own.
    expect(remedy).toContain(`--customer-id`);
    expect(remedy).toContain(ROUTING_KEY);
    expect(remedy).toContain(`cluster-settings set --global-workflows-enabled true`);
  });

  it('gives the ordinary opt-in remedy when a real org denied', async () => {
    // The control for the case above: the anchor-specific remedy is about the
    // anchor, not about denial in general. A real org that has not opted in is
    // a configuration choice, not a mapping gap.
    const lines = captureLogLines();
    try {
      await processWebhook(makeInfo(), makeDeps({ allowed: false, orgId: REAL_ORG }).deps);
    } finally {
      lines.restore();
    }

    const line = lines.find();
    expect(line.orgId).toBe(REAL_ORG);
    expect(line.remedy).toContain(`--org ${REAL_ORG}`);
    expect(line.remedy).not.toContain('--customer-id');
  });

  it('emits no line, and registers the global, when the policy admits', async () => {
    // The non-vacuity control for all three cases above: the same fixture with
    // an allowing policy registers the global and stays silent, so the line is
    // about the refusal and not about a path that logs unconditionally.
    const lines = captureLogLines();
    let h!: Harness;
    try {
      h = makeDeps({ allowed: true, orgId: REAL_ORG });
      await processWebhook(makeInfo(), h.deps);
    } finally {
      lines.restore();
    }

    expect(h.isWorkflowRepoAllowed).toHaveBeenCalled();
    expect(h.registered().sort()).toEqual([GLOBAL_WORKFLOW, PER_REPO_WORKFLOW].sort());
    expect(h.markedGlobal()).toEqual([GLOBAL_WORKFLOW]);
    expect(lines.count()).toBe(0);
  });
});

/**
 * The other route to the anchor, and the one that used to leave no trace at
 * all: `resolveOrgIdSafe` catching a DB fault and downgrading to
 * `'__default__'`.
 *
 * The downgrade is not neutral — it denies every org-scoped decision
 * downstream — so a silent catch makes a transient DB fault look exactly like a
 * source an operator deliberately left unmapped, and the exclusion line above
 * would then report a mapping remedy for a mapping that is perfectly fine.
 */
describe('a failed org lookup says the org was downgraded, not resolved', () => {
  it('logs the fault and still falls back to the anchor', async () => {
    const lines = captureLogLines();
    let h!: Harness;
    try {
      h = makeDeps({ allowed: false });
      (h.deps as unknown as { db: unknown }).db = {
        selectFrom: () => {
          throw new Error('relation "sources" does not exist');
        },
      };
      await processWebhook(makeInfo(), h.deps);
    } finally {
      lines.restore();
    }

    const failure = lines.findLookupFailure();
    expect(failure.routingKey).toBe(ROUTING_KEY);
    expect(failure.error).toContain('relation "sources" does not exist');
    // The fallback still happens — this is a report, not a behaviour change.
    expect(lines.find().orgId).toBe(DEFAULT_ORG);
  });

  it('emits no failure line when the lookup succeeds', async () => {
    // The non-vacuity control: the line is about the catch, not about every
    // delivery that ends up on the anchor. The fixture below resolves the
    // anchor cleanly, from a source row that genuinely carries it.
    const lines = captureLogLines();
    try {
      await processWebhook(makeInfo(), makeDeps({ allowed: false }).deps);
    } finally {
      lines.restore();
    }

    expect(lines.countLookupFailures()).toBe(0);
    expect(lines.find().orgId).toBe(DEFAULT_ORG);
  });
});

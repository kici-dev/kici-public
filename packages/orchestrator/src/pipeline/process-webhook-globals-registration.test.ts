/**
 * A global workflow the org policy refuses to register says so, by name.
 *
 * When `isWorkflowRepoAllowed` denies, a default-branch push's global workflows
 * are stripped from the registration set; the log line must name the workflows
 * and the org the policy decided against. The denial commonly comes from the
 * `'__default__'` org anchor, which no operator configured, while the reason
 * string reads as if it were their org.
 *
 * The failure is remote from its cause: the exclusion happens on the AUTHORING
 * repo's push, and what gets investigated, days later, is a cross-repo event
 * that dispatched nothing — with no registration row and no run, "refused
 * registration" and "declares no globals" are indistinguishable.
 *
 * `registerWorkflowsOnDefaultBranchPush` is module-private, so it is driven
 * through `processWebhook`, which also exercises the default-branch gate.
 */
import { describe, it, expect, vi } from 'vitest';
import { COMPILE_SCHEMA_VERSION } from '@kici-dev/shared';
import { processWebhook } from './process-webhook.js';
import type { WebhookInfo } from '../webhook/handler.js';

const WORKFLOW_REPO = 'acme/org-workflows';
const GLOBAL_WORKFLOW = 'org-ci';
const PER_REPO_WORKFLOW = 'repo-ci';
const ROUTING_KEY = 'github:1';
/** The plane's no-tenant anchor — what `resolveOrgId` reports for an unmapped source. */
const DEFAULT_ORG = '__default__';
const REAL_ORG = 'org_acmeOrg00001';

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
function workflow(
  name: string,
  repos?: Array<{ type: 'glob'; pattern: string }>,
  compileSchemaVersion = 1,
) {
  return {
    name,
    contentHash: `${name}-hash`,
    compileSchemaVersion,
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
 * Capture the orchestrator's own log lines for the duration of a call. Winston's
 * Console transport writes to `console._stdout` when Node exposes it, else to
 * `process.stdout`; spying on `process.stdout` alone records nothing under
 * vitest.
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
  /** The dependency-cache key the store was told to record. */
  depCacheKey: () => unknown;
  isWorkflowRepoAllowed: ReturnType<typeof vi.fn>;
}

/**
 * Deps for a default-branch push whose lock file declares one global plus one
 * ordinary workflow. Load-bearing: a single-workflow fixture cannot tell
 * "dropped the globals" from "dropped everything".
 */
function makeDeps(over: {
  allowed: boolean;
  orgId?: string;
  reason?: string;
  /** Dependency-cache fields the registering lock file records. */
  lockKey?: { lockfileHash?: string; siblingsDigest?: string };
  /** The compile schema every workflow of the registering lock declares. */
  compileSchemaVersion?: number;
}): Harness {
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
    },
    dispatcher: { dispatch: vi.fn(async () => ({ status: 'queued', jobId: 'j1' })) },
    lockFileCache: {
      get: vi.fn(async () => ({
        schemaVersion: 34,
        source: { file: '.kici/workflows/ci.ts', export: '#default' },
        contentHash: 'srchash',
        ...over.lockKey,
        workflows: [
          workflow(GLOBAL_WORKFLOW, [{ type: 'glob', pattern: '**' }], over.compileSchemaVersion),
          workflow(PER_REPO_WORKFLOW, undefined, over.compileSchemaVersion),
        ],
      })),
    },
  } as unknown as Parameters<typeof processWebhook>[1];

  // Stub `resolveOrgId`'s `sources` lookup so the policy sees the org under test.
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
    depCacheKey: () =>
      ((replaceAll.mock.calls as unknown[][])[0]?.[4] as { depCacheKey?: unknown } | undefined)
        ?.depCacheKey,
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

    // The exclusion really happened; otherwise the log assertions could pass
    // over a delivery that registered everything.
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
    // The datum that identifies the cause: the policy read `org_settings` for an
    // org nobody configured.
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
    // Both the mapping remedy and the fleet-switch remedy: only the operator
    // knows whether the missing mapping is the real problem. The master switch
    // is fleet-wide, so the anchor has no per-org opt-in.
    expect(remedy).toContain(`source update ${ROUTING_KEY} --org <org>`);
    expect(remedy).toContain(`cluster-settings set --global-workflows-enabled true`);
  });

  it('gives the ordinary opt-in remedy when a real org denied', async () => {
    // Control: the anchor-specific remedy is about the anchor, not denial in
    // general; a real org's denial is a configuration choice.
    const lines = captureLogLines();
    try {
      await processWebhook(makeInfo(), makeDeps({ allowed: false, orgId: REAL_ORG }).deps);
    } finally {
      lines.restore();
    }

    const line = lines.find();
    expect(line.orgId).toBe(REAL_ORG);
    expect(line.remedy).toContain(`--org ${REAL_ORG}`);
    expect(line.remedy).not.toContain('source update');
  });

  it('emits no line, and registers the global, when the policy admits', async () => {
    // Non-vacuity control for the cases above: the line is about the refusal,
    // not a path that logs unconditionally.
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
 * The other route to the anchor: `resolveOrgIdSafe` catching a DB fault and
 * downgrading to `'__default__'`. The downgrade denies every org-scoped
 * decision downstream, so a silent catch makes a transient DB fault look like a
 * deliberately unmapped source, and the exclusion line would report a wrong
 * mapping remedy.
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
    // Non-vacuity control: the line is about the catch, not every delivery on
    // the anchor; this fixture resolves the anchor cleanly from a source row.
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

/**
 * A registration records the dependency-cache key of the lock file that
 * registered it, so a global run dispatched from the registration probes the
 * dependency cache with the key a per-repository run of the same lock uses.
 */
describe('a default-branch push records the lock file dependency-cache key', () => {
  it('hands the store the lock file key', async () => {
    // fails-when: the push path drops the key, so every global run installs its dependencies
    const h = makeDeps({
      allowed: true,
      orgId: REAL_ORG,
      lockKey: { lockfileHash: 'lock-hash-1', siblingsDigest: 'siblings-1' },
    });

    await processWebhook(makeInfo(), h.deps);

    expect(h.registered().sort()).toEqual([GLOBAL_WORKFLOW, PER_REPO_WORKFLOW].sort());
    expect(h.depCacheKey()).toEqual({ lockfileHash: 'lock-hash-1', siblingsDigest: 'siblings-1' });
  });

  it('hands the store no key when the lock file records none', async () => {
    // breaks-if-wrong: a lock with no dependency lockfile must clear a key an earlier lock stored
    const h = makeDeps({ allowed: true, orgId: REAL_ORG });

    await processWebhook(makeInfo(), h.deps);

    expect(h.depCacheKey()).toEqual({ lockfileHash: null, siblingsDigest: null });
  });
});

describe('a default-branch push warns about a lock with a stale compile schema', () => {
  const STALE = 'Registered workflow lock has a stale compile schema';

  async function staleLines(compileSchemaVersion: number): Promise<Array<Record<string, unknown>>> {
    const stream =
      (console as unknown as { _stdout?: NodeJS.WriteStream })._stdout ?? process.stdout;
    const lines: string[] = [];
    const write = vi.spyOn(stream, 'write').mockImplementation((chunk: unknown): boolean => {
      lines.push(String(chunk));
      return true;
    });
    try {
      const h = makeDeps({ allowed: true, orgId: REAL_ORG, compileSchemaVersion });
      await processWebhook(makeInfo(), h.deps);
    } finally {
      write.mockRestore();
    }
    return lines
      .filter((l) => l.includes(STALE))
      .map((l) => JSON.parse(l) as Record<string, unknown>);
  }

  // fails-when: the registration path never compares the lock's schema with this release's
  it('logs one warning per stale workflow', async () => {
    const lines = await staleLines(COMPILE_SCHEMA_VERSION - 2);
    expect(lines.map((l) => l.workflow).sort()).toEqual(
      [GLOBAL_WORKFLOW, PER_REPO_WORKFLOW].sort(),
    );
    expect(lines.find((l) => l.workflow === GLOBAL_WORKFLOW)).toMatchObject({
      repo: WORKFLOW_REPO,
      lockSchema: COMPILE_SCHEMA_VERSION - 2,
      agentSchema: COMPILE_SCHEMA_VERSION,
      isGlobal: true,
    });
  });

  // breaks-if-wrong: a lock compiled for this release's schema logs nothing
  it('logs nothing for a current lock', async () => {
    expect(await staleLines(COMPILE_SCHEMA_VERSION)).toEqual([]);
  });
});

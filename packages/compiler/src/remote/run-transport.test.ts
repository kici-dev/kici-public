import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { HeldRunSummary } from '@kici-dev/engine';
import { createDirectTransport, createPlatformTransport } from './run-transport.js';
import type { PlatformRunClient } from './platform-client.js';
import type { DirectRunClient, DirectWhoami } from './direct-client.js';
import * as uploader from './uploader.js';

vi.mock('./uploader.js', async (orig) => {
  const actual = await orig<typeof uploader>();
  return { ...actual, uploadTarball: vi.fn() };
});

const HOLD = { id: 'h1', runId: 'r1', status: 'pending' } as HeldRunSummary;

const WHOAMI: DirectWhoami = {
  tokenId: 'tok-1',
  label: 'dev',
  subject: 'dev@x.test',
  role: 'admin',
  mode: 'independent',
  orgId: '__default__',
  permissions: { trigger: true, read: true },
};

function platformClient() {
  return {
    initUpload: vi.fn(async () => ({
      uploadId: 'u',
      signedUrl: 's',
      publicKey: 'p',
      expiresIn: 1,
    })),
    trigger: vi.fn(async () => ({ runId: 'r', status: 'accepted' })),
    runStatus: vi.fn(async () => ({ runId: 'r', status: 'running', jobs: [], done: false })),
    runLogs: vi.fn(async () => ({ lines: [], nextCursor: 0, done: false })),
    cancel: vi.fn(async () => ({ cancelled: true })),
  } as unknown as PlatformRunClient & Record<string, ReturnType<typeof vi.fn>>;
}

beforeEach(() => {
  vi.mocked(uploader.uploadTarball).mockReset();
});

describe('createPlatformTransport', () => {
  it('forwards org, cluster target and body to the Platform client unchanged', async () => {
    const client = platformClient();
    const target = { orchestrator: 'east' };
    const t = createPlatformTransport({
      client,
      orgId: 'org_1',
      target,
      endpoint: 'https://api',
      token: 'pat',
    });
    const body = { fixtureId: 'f', event: { type: 'push', targetBranch: 'main', payload: {} } };
    await t.trigger(body);
    await t.initUpload({ sha: 'x' });
    await t.status('r');
    await t.logs('r', 4);
    await t.cancel('r');
    // breaks-if-wrong: the Platform path stays identical
    expect(client.trigger).toHaveBeenCalledWith('org_1', target, body);
    expect(client.initUpload).toHaveBeenCalledWith('org_1', target, { sha: 'x' });
    expect(client.runStatus).toHaveBeenCalledWith('org_1', 'r', target);
    expect(client.runLogs).toHaveBeenCalledWith('org_1', 'r', 4, target);
    expect(client.cancel).toHaveBeenCalledWith('org_1', 'r', target);
    expect(t.holds.answerHint(HOLD)).toBe('kici approve r1 --hold h1');
    expect(t.kind).toBe('platform');
  });

  it("lists and answers holds in the run's org, not the saved active org", async () => {
    const calls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        calls.push(url);
        return new Response(JSON.stringify({ heldRuns: [HOLD] }), { status: 200 });
      }),
    );
    try {
      const t = createPlatformTransport({
        client: platformClient(),
        orgId: 'org_flag',
        target: {},
        endpoint: 'https://api',
        token: 'pat',
      });
      expect(await t.holds.list('r1')).toEqual([HOLD]);
      // fails-when: the hold listing resolves its org from the saved config, so a
      // `kici run remote --org` run never sees its own holds
      expect(calls).toEqual(['https://api/api/v1/orgs/org_flag/held-runs?runId=r1']);
      expect(await t.holds.context()).toEqual({
        endpoint: 'https://api',
        token: 'pat',
        orgId: 'org_flag',
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe('createDirectTransport', () => {
  const direct = () =>
    ({
      url: 'https://ci.example.com',
      decideHold: vi.fn(async () => true),
      listHolds: vi.fn(async () => [HOLD]),
    }) as unknown as DirectRunClient & Record<string, ReturnType<typeof vi.fn>>;

  it('names the orchestrator, the caller and who chooses the org in its banner', () => {
    const t = createDirectTransport({ client: direct(), whoami: WHOAMI });
    const banner = t.banner.join('\n');
    expect(banner).toContain('https://ci.example.com');
    expect(banner).toContain('dev (dev@x.test)');
    expect(banner).toContain('orchestrator chooses the organization');
  });

  it('answers holds through the orchestrator admin routes', async () => {
    const client = direct();
    const t = createDirectTransport({ client, whoami: WHOAMI });
    expect(await t.holds.list('r1')).toEqual([HOLD]);
    expect(client.listHolds).toHaveBeenCalledWith('__default__', 'r1');
    const ctx = await t.holds.context();
    expect(ctx).not.toBeNull();
    // fails-when: the transport drops its autoApprove argument — the call then
    // carries false and the orchestrator audits a manual held_run.approve.
    await t.holds.approve(ctx!, 'h1', true);
    expect(client.decideHold).toHaveBeenLastCalledWith(
      '__default__',
      'h1',
      'approve',
      undefined,
      true,
    );
    // breaks-if-wrong: an interactive approve stays a manual approval.
    await t.holds.approve(ctx!, 'h2');
    expect(client.decideHold).toHaveBeenLastCalledWith(
      '__default__',
      'h2',
      'approve',
      undefined,
      false,
    );
    await t.holds.reject(ctx!, 'h3', 'no');
    expect(client.decideHold).toHaveBeenLastCalledWith('__default__', 'h3', 'reject', 'no', false);
    expect(t.holds.answerHint(HOLD)).toBe(
      'kici-admin held-run approve --org __default__ --run-id r1 --hold h1',
    );
  });

  it('has no hold context before the orchestrator knows its org', async () => {
    const t = createDirectTransport({ client: direct(), whoami: { ...WHOAMI, orgId: null } });
    expect(await t.holds.context()).toBeNull();
    expect(await t.holds.list('r1')).toEqual([]);
  });
});

describe('uploadTarball diagnosis', () => {
  async function failedUpload(t: ReturnType<typeof createDirectTransport>): Promise<Error> {
    vi.mocked(uploader.uploadTarball).mockImplementation(async () => {
      throw new Error('fetch failed');
    });
    return t
      .uploadTarball({
        tarballPath: '/tmp/x',
        signedUrl: 'http://host.docker.internal:8333/b/k?X-Amz-Signature=abc',
        orchestratorPublicKey: Buffer.from(''),
      })
      .then(
        () => new Error('upload unexpectedly succeeded'),
        (e: unknown) => e as Error,
      );
  }

  it('names the upload address on the Platform transport', async () => {
    const t = createPlatformTransport({
      client: platformClient(),
      orgId: 'o',
      target: {},
      endpoint: 'e',
      token: 'pat',
    });
    expect((await failedUpload(t)).message).toMatch(
      /host\.docker\.internal:8333.*KICI_STORAGE_UPLOAD_ENDPOINT/,
    );
  });

  it('names the upload address on the direct transport', async () => {
    const t = createDirectTransport({
      client: { url: 'https://ci' } as unknown as DirectRunClient,
      whoami: WHOAMI,
    });
    expect((await failedUpload(t)).message).toMatch(
      /host\.docker\.internal:8333.*KICI_STORAGE_UPLOAD_ENDPOINT/,
    );
  });
});

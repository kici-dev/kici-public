import { describe, expect, it, vi } from 'vitest';
import type { ProviderBundle, ProviderRegistry } from '../provider-registry.js';
import {
  crossHostAuthRefusal,
  gitHostOf,
  resolveDispatchCloneAuth,
  type DispatchAuthJob,
} from './dispatch-git-auth.js';

const SOURCE_REPO = 'org/app';
const WORKFLOW_REPO = 'org/ci';
const SOURCE_CONTEXT = { installationId: 3 };
const WORKFLOW_CONTEXT = { installationId: 9 };

/** A bundle whose clone tokens are `${label}:${repo}:${installationId}`; `null` mints nothing. */
function tokenBundle(label: string, mint: 'ok' | 'null' | 'throw' = 'ok') {
  const createCloneToken = vi.fn(async (repo: string, ctx: unknown) => {
    if (mint === 'throw') throw new Error('installation suspended');
    if (mint === 'null') return null;
    return `${label}:${repo}:${(ctx as { installationId?: number }).installationId}`;
  });
  return {
    createCloneToken,
    bundle: { cloneTokenProvider: { createCloneToken } } as unknown as ProviderBundle,
  };
}

function registryOf(bundles: Record<string, ProviderBundle>): ProviderRegistry {
  return { getByRoutingKey: (key: string) => bundles[key] } as unknown as ProviderRegistry;
}

/** A global job from `org/app`, whose workflow lives in `org/ci` behind `workflowRoutingKey`. */
function globalJob(over: {
  routingKey: string;
  workflowRoutingKey: string;
  repoUrl?: string;
  workflowRepoUrl?: string;
}): DispatchAuthJob {
  return {
    id: 'job-1',
    repoUrl: over.repoUrl ?? `https://github.com/${SOURCE_REPO}.git`,
    routingKey: over.routingKey,
    providerContext: SOURCE_CONTEXT,
    jobConfig: {
      isGlobalWorkflow: true,
      workflowRepoIdentifier: WORKFLOW_REPO,
      workflowRepoUrl: over.workflowRepoUrl ?? `https://github.com/${WORKFLOW_REPO}.git`,
      workflowRoutingKey: over.workflowRoutingKey,
      workflowProviderContext: WORKFLOW_CONTEXT,
    },
  };
}

describe('resolveDispatchCloneAuth', () => {
  it("mints the workflow repo's auth for that repo even when both share one routing key", async () => {
    // fails-when: the workflow auth mirrors the source auth, so repo A is cloned with B's token
    const shared = tokenBundle('gh');
    const result = await resolveDispatchCloneAuth({
      providerRegistry: registryOf({ 'rk-1': shared.bundle }),
      bundle: shared.bundle,
      repoIdentifier: SOURCE_REPO,
      job: globalJob({ routingKey: 'rk-1', workflowRoutingKey: 'rk-1' }),
    });
    expect(result).toHaveProperty('auth');
    const { auth } = result as { auth: Record<string, { secret?: string }> };
    expect(shared.createCloneToken).toHaveBeenCalledWith(WORKFLOW_REPO, WORKFLOW_CONTEXT);
    expect(shared.createCloneToken).toHaveBeenCalledWith(SOURCE_REPO, SOURCE_CONTEXT);
    expect(auth.workflowAuth?.secret).toBe(`gh:${WORKFLOW_REPO}:9`);
    expect(auth.sourceAuth?.secret).toBe(`gh:${SOURCE_REPO}:3`);
  });

  it("mints a cross-provider workflow repo's auth through its own bundle", async () => {
    const inbound = tokenBundle('b');
    const workflow = tokenBundle('a');
    const result = await resolveDispatchCloneAuth({
      providerRegistry: registryOf({ 'rk-b': inbound.bundle, 'rk-a': workflow.bundle }),
      bundle: inbound.bundle,
      repoIdentifier: SOURCE_REPO,
      job: globalJob({ routingKey: 'rk-b', workflowRoutingKey: 'rk-a' }),
    });
    const { auth } = result as { auth: Record<string, { secret?: string }> };
    expect(workflow.createCloneToken).toHaveBeenCalledWith(WORKFLOW_REPO, WORKFLOW_CONTEXT);
    expect(inbound.createCloneToken).not.toHaveBeenCalledWith(WORKFLOW_REPO, expect.anything());
    expect(auth.workflowAuth?.secret).toBe(`a:${WORKFLOW_REPO}:9`);
  });

  it("mints a global run's __build__ job auth for the workflow repo through its bundle", async () => {
    // The build job clones the workflow repository: its repoUrl, routing key and provider
    // context are the workflow repository's, so the source-auth mint targets that repository.
    // fails-when: the build job's clone auth is minted through the inbound bundle or for org/app
    const inbound = tokenBundle('b');
    const workflow = tokenBundle('a');
    const result = await resolveDispatchCloneAuth({
      providerRegistry: registryOf({ 'rk-b': inbound.bundle, 'rk-a': workflow.bundle }),
      bundle: workflow.bundle,
      repoIdentifier: WORKFLOW_REPO,
      job: {
        id: 'build-1',
        repoUrl: `https://github.com/${WORKFLOW_REPO}.git`,
        routingKey: 'rk-a',
        providerContext: { ...WORKFLOW_CONTEXT, token: 'minted-at-dispatch' },
        jobConfig: { buildOnly: true },
      },
    });
    const { auth } = result as { auth: Record<string, { secret?: string }> };
    expect(workflow.createCloneToken).toHaveBeenCalledWith(
      WORKFLOW_REPO,
      expect.objectContaining(WORKFLOW_CONTEXT),
    );
    expect(inbound.createCloneToken).not.toHaveBeenCalled();
    expect(auth.sourceAuth?.secret).toBe(`a:${WORKFLOW_REPO}:9`);
    expect(auth.workflowAuth).toBeUndefined();
  });

  it('refuses a global job whose source auth is missing when the workflow repo is on another host', async () => {
    const inbound = tokenBundle('b', 'null');
    const workflow = tokenBundle('a');
    const result = await resolveDispatchCloneAuth({
      providerRegistry: registryOf({ 'rk-b': inbound.bundle, 'rk-a': workflow.bundle }),
      bundle: inbound.bundle,
      repoIdentifier: SOURCE_REPO,
      job: globalJob({
        routingKey: 'rk-b',
        workflowRoutingKey: 'rk-a',
        repoUrl: `https://git.forge.example/${SOURCE_REPO}.git`,
      }),
    });
    expect(result).toHaveProperty('refused');
    const { refused } = result as { refused: string };
    expect(refused).toContain(SOURCE_REPO);
    expect(refused).toContain(WORKFLOW_REPO);
  });

  it('dispatches with only the workflow auth when both repos share a host', async () => {
    // breaks-if-wrong: a same-host global job whose source mint failed must still dispatch
    const inbound = tokenBundle('b', 'throw');
    const workflow = tokenBundle('a');
    const result = await resolveDispatchCloneAuth({
      providerRegistry: registryOf({ 'rk-b': inbound.bundle, 'rk-a': workflow.bundle }),
      bundle: inbound.bundle,
      repoIdentifier: SOURCE_REPO,
      job: globalJob({ routingKey: 'rk-b', workflowRoutingKey: 'rk-a' }),
    });
    expect(result).toHaveProperty('auth');
    const { auth } = result as { auth: Record<string, unknown> };
    expect(auth.workflowAuth).toBeDefined();
    expect(auth.sourceAuth).toBeUndefined();
  });

  it("refuses a global job whose workflow repo auth is missing when the source repo's is on another host", async () => {
    // fails-when: only the direction "source auth missing" is checked, so the agent sends
    //   B's token to A's host for the workflow clone
    const inbound = tokenBundle('b');
    const workflow = tokenBundle('a', 'throw');
    const result = await resolveDispatchCloneAuth({
      providerRegistry: registryOf({ 'rk-b': inbound.bundle, 'rk-a': workflow.bundle }),
      bundle: inbound.bundle,
      repoIdentifier: SOURCE_REPO,
      job: globalJob({
        routingKey: 'rk-b',
        workflowRoutingKey: 'rk-a',
        workflowRepoUrl: `https://git.forge.example/${WORKFLOW_REPO}.git`,
      }),
    });
    expect(result).toHaveProperty('refused');
    const { refused } = result as { refused: string };
    expect(refused).toContain(
      `no clone credentials could be minted for the workflow repository ${WORKFLOW_REPO}`,
    );
    expect(refused).toContain(SOURCE_REPO);
  });

  it('dispatches with only the source auth when both repos share a host', async () => {
    // breaks-if-wrong: a same-host global job whose workflow mint failed must still dispatch
    const inbound = tokenBundle('b');
    const workflow = tokenBundle('a', 'throw');
    const result = await resolveDispatchCloneAuth({
      providerRegistry: registryOf({ 'rk-b': inbound.bundle, 'rk-a': workflow.bundle }),
      bundle: inbound.bundle,
      repoIdentifier: SOURCE_REPO,
      job: globalJob({ routingKey: 'rk-b', workflowRoutingKey: 'rk-a' }),
    });
    const { auth } = result as { auth: Record<string, unknown> };
    expect(auth.sourceAuth).toBeDefined();
    expect(auth.workflowAuth).toBeUndefined();
  });

  it('mints no workflow auth for a same-repo job', async () => {
    const shared = tokenBundle('gh');
    const result = await resolveDispatchCloneAuth({
      providerRegistry: registryOf({ 'rk-1': shared.bundle }),
      bundle: shared.bundle,
      repoIdentifier: SOURCE_REPO,
      job: {
        id: 'job-1',
        repoUrl: `https://github.com/${SOURCE_REPO}.git`,
        routingKey: 'rk-1',
        providerContext: SOURCE_CONTEXT,
        jobConfig: {},
      },
    });
    const { auth } = result as { auth: Record<string, unknown> };
    expect(auth.workflowAuth).toBeUndefined();
    expect(auth.sourceAuth).toBeDefined();
    expect(shared.createCloneToken).toHaveBeenCalledTimes(1);
  });
});

describe('crossHostAuthRefusal', () => {
  const workflowAuth = { kind: 'basic' as const, user: 'x-access-token', secret: 'a' };
  const cfg = {
    isGlobalWorkflow: true,
    workflowRepoIdentifier: WORKFLOW_REPO,
    workflowRepoUrl: `git@github.com:${WORKFLOW_REPO}.git`,
  };

  it('compares scp-style and https hosts', () => {
    expect(gitHostOf(`git@github.com:${WORKFLOW_REPO}.git`)).toBe('github.com');
    expect(gitHostOf(`https://github.com/${SOURCE_REPO}.git`)).toBe('github.com');
    expect(
      crossHostAuthRefusal(cfg, `https://github.com/${SOURCE_REPO}.git`, { workflowAuth }),
    ).toBeUndefined();
  });

  it('refuses when a host cannot be parsed', () => {
    // fails-when: an unparseable source URL is read as "same host"
    expect(crossHostAuthRefusal(cfg, 'not a url', { workflowAuth })).toBeDefined();
  });

  it('dispatches a networked source with a token next to a file:// workflow repository', () => {
    // A file:// clone reaches no host, so the one credential cannot leak to one.
    // breaks-if-wrong: a local workflow repository paired with a networked source must still dispatch
    expect(
      crossHostAuthRefusal(
        { ...cfg, workflowRepoUrl: 'file:///srv/repos/org/ci' },
        `https://github.com/${SOURCE_REPO}.git`,
        { token: 'src-tok', sourceAuth: workflowAuth },
      ),
    ).toBeUndefined();
  });

  it('dispatches a file:// source next to a networked workflow repository with a token', () => {
    // breaks-if-wrong: a local source paired with a networked workflow repository must still dispatch
    expect(
      crossHostAuthRefusal(cfg, 'file:///srv/repos/org/app', { workflowAuth }),
    ).toBeUndefined();
  });

  it('reads a file:// URL that names a host as hostless too', () => {
    // `new URL('file://localhost/x').host` is 'localhost', yet git reads the path locally.
    expect(
      crossHostAuthRefusal(cfg, 'file://localhost/srv/repos/org/app', { workflowAuth }),
    ).toBeUndefined();
  });

  it('reads a userless scp-style location as its host, not as a local path', () => {
    // git reads `github.com:org/repo.git` as ssh to github.com, while
    // `new URL` parses it as scheme `github.com:` with an empty host.
    expect(gitHostOf('github.com:org/repo.git')).toBe('github.com');
    // fails-when: the userless scp form is read as hostless and the one credential crosses hosts
    expect(
      crossHostAuthRefusal(
        { ...cfg, workflowRepoUrl: 'github.com:org/ci.git' },
        'https://git.forge.example/org/app.git',
        { token: 'src-tok' },
      ),
    ).toBeDefined();
  });

  it('compares an scp-style host case-insensitively with a URL host', () => {
    expect(gitHostOf('git@GitHub.com:org/ci.git')).toBe('github.com');
    // breaks-if-wrong: one host spelled in two cases must still dispatch with the one credential
    expect(
      crossHostAuthRefusal(
        { ...cfg, workflowRepoUrl: 'git@GitHub.com:org/ci.git' },
        'https://github.com/org/app.git',
        { token: 'src-tok' },
      ),
    ).toBeUndefined();
  });

  it('lowercases the host of a non-special scheme URL too', () => {
    expect(gitHostOf('ssh://git@GitHub.com/org/ci.git')).toBe('github.com');
    // breaks-if-wrong: an ssh URL and an scp location on one host must still dispatch with the one credential
    expect(
      crossHostAuthRefusal(
        { ...cfg, workflowRepoUrl: 'ssh://git@GitHub.com/org/ci.git' },
        'git@github.com:org/app.git',
        { token: 'src-tok' },
      ),
    ).toBeUndefined();
  });

  it('reads an absolute path and a file:// URL as hostless', () => {
    for (const local of ['/srv/repo.git', 'file:///srv/repo.git']) {
      expect(crossHostAuthRefusal(cfg, local, { workflowAuth })).toBeUndefined();
    }
  });

  it('still refuses two different network hosts with one credential', () => {
    // fails-when: the hostless carve-out also exempts a networked pair on different hosts
    expect(
      crossHostAuthRefusal(cfg, 'https://git.forge.example/org/app.git', { workflowAuth }),
    ).toBeDefined();
  });

  it('never refuses a job that carries source auth', () => {
    expect(
      crossHostAuthRefusal(cfg, 'https://git.forge.example/org/app.git', {
        workflowAuth,
        sourceAuth: workflowAuth,
      }),
    ).toBeUndefined();
  });
});

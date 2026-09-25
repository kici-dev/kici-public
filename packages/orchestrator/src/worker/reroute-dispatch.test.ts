import { describe, expect, it } from 'vitest';
import type { JobReroute } from '@kici-dev/engine';
import {
  buildWorkerDispatchMessage,
  rerouteDispatchRefusal,
  rerouteJobConfig,
} from './reroute-dispatch.js';

const IDS = { messageId: 'msg-1', timestamp: 1_700_000_000_000 };

function reroute(over: Partial<JobReroute> = {}): JobReroute {
  return {
    type: 'job.reroute',
    messageId: 'rr-1',
    jobId: 'job-1',
    runId: 'run-1',
    deliveryId: 'd-1',
    routingKey: 'github:42',
    event: 'push',
    action: null,
    payload: {},
    jobName: 'build',
    workflowName: 'ci',
    runsOnLabels: [['linux']],
    triedConnections: [],
    maxHops: 3,
    coordinatorId: 'coord-1',
    jobConfig: { isGlobalWorkflow: true, cacheOrgId: 'org-1', secrets: { S: 'v' } },
    ...over,
  } as JobReroute;
}

/** The queued job the worker dispatcher hands onDispatch for a reroute message. */
function queuedJob(msg: JobReroute) {
  return {
    id: msg.jobId,
    runId: msg.runId,
    jobName: msg.jobName,
    workflowName: msg.workflowName,
    repoUrl: 'https://git.example/org/app.git',
    ref: 'main',
    sha: 'b1',
    jobConfig: rerouteJobConfig(msg),
  };
}

describe('worker dispatch of a rerouted job', () => {
  it("authenticates the workflow repo with the workflow repo's clone token", () => {
    const msg = reroute({ cloneToken: 'src-tok', workflowCloneToken: 'wf-tok' });
    const dispatch = buildWorkerDispatchMessage(queuedJob(msg), IDS);
    // fails-when: the worker drops workflowCloneToken, so the agent clones A with B's token
    expect(dispatch.workflowAuth).toEqual({
      kind: 'basic',
      user: 'x-access-token',
      secret: 'wf-tok',
    });
    // fails-when: sourceAuth is absent, so the agent's source clone falls back to workflowAuth (A's token)
    expect(dispatch.sourceAuth).toEqual({
      kind: 'basic',
      user: 'x-access-token',
      secret: 'src-tok',
    });
    expect(dispatch.token).toBe('src-tok');
    // fails-when: a clone token is forwarded inside the agent-visible job config
    expect(dispatch.jobConfig).not.toHaveProperty('workflowCloneToken');
    expect(dispatch.jobConfig).not.toHaveProperty('cloneToken');
  });

  it('dispatches a reroute from a coordinator that sends no workflow clone token exactly as before', () => {
    // breaks-if-wrong: an older coordinator's reroute must reach the agent with the source token alone
    const msg = reroute({ cloneToken: 'src-tok' });
    expect(buildWorkerDispatchMessage(queuedJob(msg), IDS)).toEqual({
      type: 'job.dispatch',
      messageId: 'msg-1',
      timestamp: 1_700_000_000_000,
      runId: 'run-1',
      jobId: 'job-1',
      jobName: 'build',
      workflowName: 'ci',
      repoUrl: 'https://git.example/org/app.git',
      ref: 'main',
      sha: 'b1',
      lockFileUrl: '',
      jobConfig: { isGlobalWorkflow: true, cacheOrgId: 'org-1' },
      orgId: 'org-1',
      token: 'src-tok',
      secrets: { S: 'v' },
    });
  });

  it('carries both clone tokens from the reroute message into the job config', () => {
    // fails-when: rerouteJobConfig copies cloneToken but not workflowCloneToken
    expect(rerouteJobConfig(reroute({ cloneToken: 's', workflowCloneToken: 'w' }))).toMatchObject({
      cloneToken: 's',
      workflowCloneToken: 'w',
    });
    // breaks-if-wrong: a message without the field leaves no workflowCloneToken key
    expect(rerouteJobConfig(reroute({ cloneToken: 's' }))).not.toHaveProperty('workflowCloneToken');
  });

  it("never forwards the workflow repo's routing key or provider context to the agent", () => {
    // fails-when: the worker forwards the coordinator-only auth context inside the job config
    const msg = reroute({
      cloneToken: 'src-tok',
      jobConfig: {
        isGlobalWorkflow: true,
        workflowRoutingKey: 'github:9',
        workflowProviderContext: { installationId: 9 },
        workflowRepoIdentifier: 'org/ci',
      },
    });
    const dispatch = buildWorkerDispatchMessage(queuedJob(msg), IDS);
    expect(dispatch.jobConfig).not.toHaveProperty('workflowRoutingKey');
    expect(dispatch.jobConfig).not.toHaveProperty('workflowProviderContext');
    // breaks-if-wrong: the workflow repository the agent checks out still reaches it
    expect(dispatch.jobConfig).toMatchObject({ workflowRepoIdentifier: 'org/ci' });
  });
});

describe('rerouteDispatchRefusal', () => {
  const globalConfig = {
    isGlobalWorkflow: true,
    workflowRepoIdentifier: 'org/ci',
    workflowRepoUrl: 'https://github.com/org/ci.git',
  };

  it('refuses a global job with only the workflow token whose source is on another host', () => {
    // fails-when: the refusal compares nothing, so the agent clones org/app with the org/ci token
    const refusal = rerouteDispatchRefusal(
      reroute({
        workflowCloneToken: 'wf-tok',
        repoUrl: 'https://git.forge.example/org/app.git',
        jobConfig: globalConfig,
      }),
    );
    expect(refusal).toContain('org/app');
    expect(refusal).toContain('org/ci');
  });

  it('allows the same job when both repos share a host', () => {
    // breaks-if-wrong: a same-host global job with only the workflow token must still run
    expect(
      rerouteDispatchRefusal(
        reroute({
          workflowCloneToken: 'wf-tok',
          repoUrl: 'https://github.com/org/app.git',
          jobConfig: globalConfig,
        }),
      ),
    ).toBeUndefined();
  });

  it('refuses a global job with only the source token whose workflow repo is on another host', () => {
    // fails-when: the worker forwards `token` alone, and the agent sends it to org/ci's host
    const refusal = rerouteDispatchRefusal(
      reroute({
        cloneToken: 'src-tok',
        repoUrl: 'https://github.com/org/app.git',
        jobConfig: { ...globalConfig, workflowRepoUrl: 'https://git.forge.example/org/ci.git' },
      }),
    );
    expect(refusal).toContain(
      'no clone credentials could be minted for the workflow repository org/ci',
    );
    expect(refusal).toContain('org/app');
  });

  it('allows a global job with only the source token when both repos share a host', () => {
    // breaks-if-wrong: a same-host global job whose workflow token is missing must still run
    expect(
      rerouteDispatchRefusal(
        reroute({
          cloneToken: 'src-tok',
          repoUrl: 'https://github.com/org/app.git',
          jobConfig: globalConfig,
        }),
      ),
    ).toBeUndefined();
  });

  it('allows a source token next to a file:// workflow repository', () => {
    // breaks-if-wrong: a local workflow repository cannot receive a credential over the network
    expect(
      rerouteDispatchRefusal(
        reroute({
          cloneToken: 'src-tok',
          repoUrl: 'https://github.com/org/app.git',
          jobConfig: { ...globalConfig, workflowRepoUrl: 'file:///srv/repos/org/ci' },
        }),
      ),
    ).toBeUndefined();
  });

  it('allows a workflow token next to a file:// source repository', () => {
    expect(
      rerouteDispatchRefusal(
        reroute({
          workflowCloneToken: 'wf-tok',
          repoUrl: 'file:///srv/repos/org/app',
          jobConfig: globalConfig,
        }),
      ),
    ).toBeUndefined();
  });

  it('allows a cross-host job that also carries the source token', () => {
    expect(
      rerouteDispatchRefusal(
        reroute({
          cloneToken: 'src-tok',
          workflowCloneToken: 'wf-tok',
          repoUrl: 'https://git.forge.example/org/app.git',
          jobConfig: globalConfig,
        }),
      ),
    ).toBeUndefined();
  });
});

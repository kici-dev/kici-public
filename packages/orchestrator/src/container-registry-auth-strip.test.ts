import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { buildWorkerDispatchMessage } from './worker/reroute-dispatch.js';

/**
 * `containerRegistryAuth` carries a RESOLVED registry password. It rides on
 * `jobConfig` from the dispatch builder to the send site — which is how every
 * other resolved secret travels here — and must be lifted to a top-level
 * dispatch field and stripped from `jobConfig` before the message goes out.
 *
 * There are two independent send sites (the coordinator and the worker) with
 * two separately-maintained strip lists that already differ from each other,
 * so a field added to one and forgotten in the other is a live failure mode.
 * The coordinator's send site is asserted against its source, which needs no
 * dispatch harness; the worker's builds its message in a pure function, which is
 * driven directly.
 */
const SRC = dirname(fileURLToPath(import.meta.url));

const SEND_SITES = [{ label: 'coordinator', file: join(SRC, 'orchestrator-core.ts') }];

const REGISTRY_AUTH = { username: 'u', password: 'p', serveraddress: 'registry.example' };

describe('containerRegistryAuth never reaches the agent inside jobConfig', () => {
  it.each(SEND_SITES)('$label strips it from jobConfig', ({ file }) => {
    const src = readFileSync(file, 'utf-8');
    // Positive control: if the strip block itself moved, this test is
    // asserting nothing and should fail rather than pass silently.
    expect(src).toContain("k !== 'npmRegistries'");
    expect(src).toContain("k !== 'containerRegistryAuth'");
  });

  it.each(SEND_SITES)('$label lifts it to a top-level dispatch field', ({ file }) => {
    const src = readFileSync(file, 'utf-8');
    expect(src).toContain('containerRegistryAuth: dispatchContainerRegistryAuth');
  });

  it('worker lifts it to a top-level dispatch field and strips it from jobConfig', () => {
    // fails-when: the worker forwards the resolved password inside jobConfig, or drops it
    const dispatch = buildWorkerDispatchMessage(
      {
        id: 'job-1',
        runId: 'run-1',
        jobName: 'build',
        workflowName: 'ci',
        repoUrl: 'https://git.example/org/app.git',
        ref: 'main',
        sha: 's1',
        jobConfig: { containerRegistryAuth: REGISTRY_AUTH, npmRegistries: [{ url: 'r' }] },
      },
      { messageId: 'm-1', timestamp: 1 },
    );
    expect(dispatch.jobConfig).not.toHaveProperty('containerRegistryAuth');
    expect(dispatch.jobConfig).not.toHaveProperty('npmRegistries');
    expect(dispatch.containerRegistryAuth).toEqual(REGISTRY_AUTH);
  });
});

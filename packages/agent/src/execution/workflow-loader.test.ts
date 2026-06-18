import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import {
  loadWorkflowSource,
  extractWorkflow,
  extractDynamicJobFn,
  extractSteps,
  extractStepsFromDynamicJob,
} from './workflow-loader.js';
import type { Workflow } from '@kici-dev/sdk';
import { normalizeLineEndings } from '@kici-dev/shared';

const COMPILE_SCHEMA_VERSION = 5;

let tempDir: string;

beforeAll(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kici-wf-loader-'));

  // The loadWorkflowSource function expects @kici-dev/sdk to be resolvable from the
  // working directory's node_modules (production: cloned repo). In tests we write
  // workflow files to a temp dir, so we symlink the real SDK package there.
  const realSdk = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '../../node_modules/@kici-dev/sdk',
  );
  // Walk up to find the SDK in case pnpm hoisted it
  let sdkTarget = realSdk;
  const { existsSync } = await import('node:fs');
  if (!existsSync(sdkTarget)) {
    let dir = path.dirname(fileURLToPath(import.meta.url));
    while (dir !== path.dirname(dir)) {
      const candidate = path.join(dir, 'node_modules', '@kici-dev', 'sdk');
      if (existsSync(candidate)) {
        sdkTarget = candidate;
        break;
      }
      dir = path.dirname(dir);
    }
  }
  const scopeDir = path.join(tempDir, 'node_modules', '@kici-dev');
  await fs.mkdir(scopeDir, { recursive: true });
  await fs.symlink(sdkTarget, path.join(scopeDir, 'sdk'));
});

afterAll(async () => {
  await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
});

describe('loadWorkflowSource', () => {
  it('compiles and loads a TypeScript workflow file via rolldown', async () => {
    const sourceFile = 'test-workflow.ts';
    const sourceCode = `
import { workflow, job, step } from '@kici-dev/sdk';

export const ci = workflow('ci', {
  jobs: [
    job('build', {
      runsOn: 'linux',
      steps: [
        step('install', async ({ $ }) => {
          // no-op for test
        }),
      ],
    }),
  ],
});

export default ci;
`;
    await fs.writeFile(path.join(tempDir, sourceFile), sourceCode, 'utf-8');

    const { module } = await loadWorkflowSource(tempDir, sourceFile);

    // Should have default and named exports
    expect(module.default).toBeDefined();
    expect(module.ci).toBeDefined();

    // The exported value should be a Workflow
    const wf = module.ci as Workflow;
    expect(wf._tag).toBe('Workflow');
    expect(wf.name).toBe('ci');
    expect(wf.jobs).toHaveLength(1);
  });

  it('resolves @kici-dev/sdk imports correctly via alias', async () => {
    const sourceFile = 'test-sdk-import.ts';
    const sourceCode = `
import { workflow, job, step, pr } from '@kici-dev/sdk';

export const deploy = workflow('deploy', {
  on: pr({ target: 'main' }),
  jobs: [
    job('deploy', {
      runsOn: 'linux',
      steps: [
        step('deploy-step', async ({ log }) => {
          log.info('deploying');
        }),
      ],
    }),
  ],
});
`;
    await fs.writeFile(path.join(tempDir, sourceFile), sourceCode, 'utf-8');

    const { module } = await loadWorkflowSource(tempDir, sourceFile);

    const wf = module.deploy as Workflow;
    expect(wf._tag).toBe('Workflow');
    expect(wf.name).toBe('deploy');
    // Trigger should be present (pr trigger)
    expect(wf.on).toBeDefined();
    expect(wf.on!.length).toBeGreaterThan(0);
  });

  it('handles workflow with dynamic jobs', async () => {
    const sourceFile = 'test-dynamic.ts';
    const sourceCode = `
import { workflow, job, step } from '@kici-dev/sdk';

const staticJob = job('lint', {
  runsOn: 'linux',
  steps: [step('lint', async () => {})],
});

const dynamicJobFn = async ({ $ }: any) => {
  return [
    job('dynamic-build', {
      runsOn: 'linux',
      steps: [step('build', async () => {})],
    }),
  ];
};

export const ci = workflow('ci-dynamic', {
  jobs: [staticJob, dynamicJobFn],
});
`;
    await fs.writeFile(path.join(tempDir, sourceFile), sourceCode, 'utf-8');

    const { module } = await loadWorkflowSource(tempDir, sourceFile);

    const wf = module.ci as Workflow;
    expect(wf._tag).toBe('Workflow');
    expect(wf.name).toBe('ci-dynamic');
    expect(wf.jobs).toHaveLength(2);
    // First job is static, second is dynamic function
    expect(typeof wf.jobs[0]).toBe('object');
    expect(typeof wf.jobs[1]).toBe('function');
  });

  it('cleans up temp compiled file after loading', async () => {
    const sourceFile = 'test-cleanup.ts';
    const sourceCode = `
import { workflow, job, step } from '@kici-dev/sdk';
export default workflow('cleanup-test', {
  jobs: [job('j', { runsOn: 'linux', steps: [step('s', async () => {})] })],
});
`;
    await fs.writeFile(path.join(tempDir, sourceFile), sourceCode, 'utf-8');

    await loadWorkflowSource(tempDir, sourceFile);

    // Temp file should be cleaned up
    const tempPath = path.join(tempDir, sourceFile + '.compiled.mjs');
    await expect(fs.access(tempPath)).rejects.toThrow();
  });

  it('throws when expectedContentHash is provided and does not match compiled output', async () => {
    const sourceFile = 'test-drift.ts';
    const sourceCode = `
import { workflow, job, step } from '@kici-dev/sdk';
export default workflow('drift-test', {
  jobs: [job('j', { runsOn: 'linux', steps: [step('s', async () => {})] })],
});
`;
    await fs.writeFile(path.join(tempDir, sourceFile), sourceCode, 'utf-8');

    const wrongHash = '0'.repeat(64);

    await expect(loadWorkflowSource(tempDir, sourceFile, wrongHash)).rejects.toThrow(
      /Lock file is out of date/,
    );

    await expect(loadWorkflowSource(tempDir, sourceFile, wrongHash)).rejects.toThrow(
      /expected contentHash/,
    );
  });

  it('succeeds when expectedContentHash is not provided', async () => {
    const sourceFile = 'test-no-expected-hash.ts';
    const sourceCode = `
import { workflow, job, step } from '@kici-dev/sdk';
export default workflow('no-hash-test', {
  jobs: [job('j', { runsOn: 'linux', steps: [step('s', async () => {})] })],
});
`;
    await fs.writeFile(path.join(tempDir, sourceFile), sourceCode, 'utf-8');

    const { module } = await loadWorkflowSource(tempDir, sourceFile);
    expect(module.default).toBeDefined();
  });

  it('throws when expectedContentHash does not match and resolvedHashFiles is provided', async () => {
    const assetPath = path.join(tempDir, 'asset.txt');
    await fs.writeFile(assetPath, 'asset content', 'utf-8');
    const sourceFile = 'test-hashfiles-drift.ts';
    const sourceCode = `
import { workflow, job, step } from '@kici-dev/sdk';
export default workflow('hashfiles-drift', {
  jobs: [job('j', { runsOn: 'linux', steps: [step('s', async () => {})] })],
});
`;
    await fs.writeFile(path.join(tempDir, sourceFile), sourceCode, 'utf-8');

    const wrongHash = '0'.repeat(64);
    await expect(loadWorkflowSource(tempDir, sourceFile, wrongHash, ['asset.txt'])).rejects.toThrow(
      /Lock file is out of date|expected contentHash/,
    );
  });

  it('succeeds when expectedContentHash matches bundle and resolvedHashFiles digest', async () => {
    const assetRel = 'asset.txt';
    const assetContent = 'asset content';
    await fs.writeFile(path.join(tempDir, assetRel), assetContent, 'utf-8');
    const sourceFile = 'test-hashfiles-ok.ts';
    const sourceCode = `
import { workflow, job, step } from '@kici-dev/sdk';
export default workflow('hashfiles-ok', {
  jobs: [job('j', { runsOn: 'linux', steps: [step('s', async () => {})] })],
});
`;
    await fs.writeFile(path.join(tempDir, sourceFile), sourceCode, 'utf-8');

    // Agent and compiler both hash the raw TS source (see compiler's loadModule
    // in packages/compiler/src/execution/executor.ts). The rolldown bundle output
    // is not involved in the hash — SDK / rolldown version drift would otherwise
    // make hashes diverge across the compiler/agent boundary.
    const rawSource = sourceCode;

    const assetDigest = `${assetRel}\n${assetContent}`;
    const expectedHash = createHash('sha256')
      .update(`${COMPILE_SCHEMA_VERSION}:${rawSource}\0${assetDigest}`)
      .digest('hex');

    const { module } = await loadWorkflowSource(tempDir, sourceFile, expectedHash, [assetRel]);
    expect(module.default).toBeDefined();
  });

  it('succeeds when expectedContentHash matches raw TS source (no hashFiles)', async () => {
    const sourceFile = 'test-raw-source-hash.ts';
    const sourceCode = `
import { workflow, job, step } from '@kici-dev/sdk';
export default workflow('raw-source-hash', {
  jobs: [job('j', { runsOn: 'linux', steps: [step('s', async () => {})] })],
});
`;
    await fs.writeFile(path.join(tempDir, sourceFile), sourceCode, 'utf-8');

    const expectedHash = createHash('sha256')
      .update(`${COMPILE_SCHEMA_VERSION}:${normalizeLineEndings(sourceCode)}`)
      .digest('hex');

    const { module } = await loadWorkflowSource(tempDir, sourceFile, expectedHash);
    expect(module.default).toBeDefined();
  });

  // Regression: Git for Windows ships with `core.autocrlf=true` set in the
  // system gitconfig, so a `git clone file://...` of a Linux-authored repo on
  // a Windows host writes CRLF into the working tree. The lockfile's
  // contentHash was computed on Linux against LF source. Without
  // normalization, the agent would compute a different hash and reject every
  // dispatched workflow with "lock file is out of date".
  it('accepts LF-computed contentHash even when source on disk has CRLF endings', async () => {
    const sourceFile = 'test-crlf-source.ts';
    const sourceCodeLf = `
import { workflow, job, step } from '@kici-dev/sdk';
export default workflow('crlf-test', {
  jobs: [job('j', { runsOn: 'linux', steps: [step('s', async () => {})] })],
});
`;
    // Lockfile (compiler on Linux) hashes the LF source.
    const expectedHash = createHash('sha256')
      .update(`${COMPILE_SCHEMA_VERSION}:${sourceCodeLf}`)
      .digest('hex');

    // On disk (agent on Windows after `git clone` with autocrlf=true) the
    // source has CRLF line endings.
    const sourceCodeCrlf = sourceCodeLf.replace(/\n/g, '\r\n');
    await fs.writeFile(path.join(tempDir, sourceFile), sourceCodeCrlf, 'utf-8');

    const { module } = await loadWorkflowSource(tempDir, sourceFile, expectedHash);
    expect(module.default).toBeDefined();
  });

  it('accepts LF-computed contentHash with CRLF source AND CRLF hashFiles asset', async () => {
    const assetRel = 'crlf-asset.txt';
    const assetContentLf = 'first line\nsecond line\nthird line\n';
    const assetContentCrlf = assetContentLf.replace(/\n/g, '\r\n');
    await fs.writeFile(path.join(tempDir, assetRel), assetContentCrlf, 'utf-8');

    const sourceFile = 'test-crlf-hashfiles.ts';
    const sourceCodeLf = `
import { workflow, job, step } from '@kici-dev/sdk';
export default workflow('crlf-hashfiles', {
  jobs: [job('j', { runsOn: 'linux', steps: [step('s', async () => {})] })],
});
`;
    const sourceCodeCrlf = sourceCodeLf.replace(/\n/g, '\r\n');
    await fs.writeFile(path.join(tempDir, sourceFile), sourceCodeCrlf, 'utf-8');

    // Lockfile contentHash from the LF-source path (compiler on Linux).
    const assetDigestLf = `${assetRel}\n${assetContentLf}`;
    const expectedHash = createHash('sha256')
      .update(`${COMPILE_SCHEMA_VERSION}:${sourceCodeLf}\0${assetDigestLf}`)
      .digest('hex');

    const { module } = await loadWorkflowSource(tempDir, sourceFile, expectedHash, [assetRel]);
    expect(module.default).toBeDefined();
  });
});

describe('extractWorkflow', () => {
  it('finds workflow by name from default export', () => {
    const module: Record<string, unknown> = {
      default: {
        _tag: 'Workflow',
        name: 'ci',
        jobs: [],
      },
    };

    const wf = extractWorkflow(module, 'ci');
    expect(wf.name).toBe('ci');
  });

  it('finds workflow by name from default export array', () => {
    const module: Record<string, unknown> = {
      default: [
        { _tag: 'Workflow', name: 'ci', jobs: [] },
        { _tag: 'Workflow', name: 'deploy', jobs: [] },
      ],
    };

    const wf = extractWorkflow(module, 'deploy');
    expect(wf.name).toBe('deploy');
  });

  it('finds workflow by name from named exports', () => {
    const module: Record<string, unknown> = {
      default: undefined,
      myWorkflow: {
        _tag: 'Workflow',
        name: 'my-wf',
        jobs: [],
      },
    };

    const wf = extractWorkflow(module, 'my-wf');
    expect(wf.name).toBe('my-wf');
  });

  it('throws when workflow not found', () => {
    const module: Record<string, unknown> = {
      default: {
        _tag: 'Workflow',
        name: 'ci',
        jobs: [],
      },
    };

    expect(() => extractWorkflow(module, 'nonexistent')).toThrow(
      "Workflow 'nonexistent' not found in module exports",
    );
  });
});

describe('extractDynamicJobFn', () => {
  it('extracts dynamic job function at correct index', () => {
    const dynamicFn = async () => [];
    const workflow: Workflow = {
      _tag: 'Workflow',
      name: 'test',
      jobs: [{ _tag: 'Job', name: 'static', runsOn: 'linux', steps: [] }, dynamicFn],
    };

    const fn = extractDynamicJobFn(workflow, 1);
    expect(fn).toBe(dynamicFn);
  });

  it('throws when index out of bounds', () => {
    const workflow: Workflow = {
      _tag: 'Workflow',
      name: 'test',
      jobs: [],
    };

    expect(() => extractDynamicJobFn(workflow, 0)).toThrow('out of bounds');
  });

  it('throws when job at index is not a dynamic function', () => {
    const workflow: Workflow = {
      _tag: 'Workflow',
      name: 'test',
      jobs: [{ _tag: 'Job', name: 'static', runsOn: 'linux', steps: [] }],
    };

    expect(() => extractDynamicJobFn(workflow, 0)).toThrow('not a dynamic job fn');
  });
});

describe('extractSteps', () => {
  it('extracts steps from a static job by name', () => {
    const steps = [
      { _tag: 'Step' as const, name: 'install', run: async () => {} },
      { _tag: 'Step' as const, name: 'build', run: async () => {} },
    ];
    const workflow: Workflow = {
      _tag: 'Workflow',
      name: 'test',
      jobs: [{ _tag: 'Job', name: 'build-job', runsOn: 'linux', steps }],
    };

    const result = extractSteps(workflow, 'build-job');
    expect(result).toHaveLength(2);
    expect(result[0].name).toBe('install');
    expect(result[1].name).toBe('build');
  });

  it('throws when job not found', () => {
    const workflow: Workflow = {
      _tag: 'Workflow',
      name: 'test',
      jobs: [{ _tag: 'Job', name: 'existing', runsOn: 'linux', steps: [] }],
    };

    expect(() => extractSteps(workflow, 'nonexistent')).toThrow(
      "Static job 'nonexistent' not found",
    );
  });

  it('skips dynamic job functions when searching', () => {
    const dynamicFn = async () => [];
    const workflow: Workflow = {
      _tag: 'Workflow',
      name: 'test',
      jobs: [dynamicFn, { _tag: 'Job', name: 'static', runsOn: 'linux', steps: [] }],
    };

    const result = extractSteps(workflow, 'static');
    expect(result).toHaveLength(0);
  });
});

describe('extractStepsFromDynamicJob determinism guard', () => {
  const stepA = { _tag: 'Step' as const, name: 'run', run: async () => {} };

  function makeDynamicWorkflow(fn: (...args: any[]) => Promise<any[]>): Workflow {
    return {
      _tag: 'Workflow',
      name: 'test-wf',
      jobs: [fn],
    };
  }

  it('returns steps when target job exists and siblings match', async () => {
    const dynamicFn = async () => [
      { _tag: 'Job', name: 'job-a', runsOn: 'linux', steps: [stepA] },
      { _tag: 'Job', name: 'job-b', runsOn: 'linux', steps: [stepA] },
    ];
    const workflow = makeDynamicWorkflow(dynamicFn);

    const result = await extractStepsFromDynamicJob(workflow, 0, 'job-a', {}, {}, undefined, [
      'job-a',
      'job-b',
    ]);
    expect(result.steps).toHaveLength(1);
    expect(result.steps[0].name).toBe('run');
    expect(result.droppedJobs).toEqual([]);
  });

  it('returns steps when no expectedJobNames provided (backward compat)', async () => {
    const dynamicFn = async () => [{ _tag: 'Job', name: 'job-a', runsOn: 'linux', steps: [stepA] }];
    const workflow = makeDynamicWorkflow(dynamicFn);

    const result = await extractStepsFromDynamicJob(
      workflow,
      0,
      'job-a',
      {},
      {},
      undefined,
      undefined,
    );
    expect(result.steps).toHaveLength(1);
    expect(result.droppedJobs).toEqual([]);
  });

  it('warns but returns steps when siblings differ but target exists', async () => {
    const dynamicFn = async () => [
      { _tag: 'Job', name: 'job-a', runsOn: 'linux', steps: [stepA] },
      { _tag: 'Job', name: 'job-c', runsOn: 'linux', steps: [stepA] },
    ];
    const workflow = makeDynamicWorkflow(dynamicFn);

    // Target 'job-a' still exists even though 'job-b' is missing and 'job-c' is new
    const result = await extractStepsFromDynamicJob(workflow, 0, 'job-a', {}, {}, undefined, [
      'job-a',
      'job-b',
    ]);
    expect(result.steps).toHaveLength(1);
    // job-b was dropped (missing from re-eval), reported as drift
    expect(result.droppedJobs).toEqual(['job-b']);
  });

  it('throws determinism error when target job disappears', async () => {
    const dynamicFn = async () => [{ _tag: 'Job', name: 'job-b', runsOn: 'linux', steps: [stepA] }];
    const workflow = makeDynamicWorkflow(dynamicFn);

    await expect(
      extractStepsFromDynamicJob(workflow, 0, 'job-a', {}, {}, undefined, ['job-a', 'job-b']),
    ).rejects.toThrow(/non-deterministic re-evaluation.*job 'job-a' no longer exists/);
  });

  it('throws generic error when target missing without expectedJobNames', async () => {
    const dynamicFn = async () => [{ _tag: 'Job', name: 'job-b', runsOn: 'linux', steps: [stepA] }];
    const workflow = makeDynamicWorkflow(dynamicFn);

    await expect(extractStepsFromDynamicJob(workflow, 0, 'job-a', {}, {})).rejects.toThrow(
      /Generated job 'job-a' not found/,
    );
  });

  it('rebuilds ctx.needs from the frozen snapshot for a result-aware generator', async () => {
    // Generator names jobs from a group upstream's frozen members, proving the
    // snapshot (not a live read) drives ctx.needs on re-eval.
    const dynamicFn = async (c: any) =>
      (c.ctx.needs.scan as Array<{ name: string }>).map((entry) => ({
        _tag: 'Job',
        name: `report-${entry.name}`,
        runsOn: 'linux',
        steps: [stepA],
      }));
    const workflow = makeDynamicWorkflow(dynamicFn);

    const result = await extractStepsFromDynamicJob(
      workflow,
      0,
      'report-scan-a',
      {},
      {},
      undefined,
      ['report-scan-a'],
      { jobs: { 'scan-a': { findings: 1 } }, groups: { scan: ['scan-a'] } },
      [{ group: 'scan' }],
    );
    expect(result.steps).toHaveLength(1);
    expect(result.droppedJobs).toEqual([]);
  });
});

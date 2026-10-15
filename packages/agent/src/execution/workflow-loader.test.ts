import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import {
  loadWorkflowSource,
  resolveWorkflowSdkSetters,
  extractWorkflow,
  extractDynamicJobFn,
  extractSteps,
  extractStepsFromDynamicJob,
  COMPILE_SCHEMA_VERSION,
} from './workflow-loader.js';
import type { Workflow } from '@kici-dev/sdk';
import { normalizeLineEndings } from '@kici-dev/shared';
import { hashKiciSourceTree } from '@kici-dev/core/kici-source-digest';

let tempDir: string;

/**
 * Link the real `@kici-dev/sdk` into `dir/node_modules`, so the loader's
 * `createRequire` walk resolves it as in a cloned repo. Every fixture the loader
 * must accept needs it: a bare temp tree resolves the SDK only where pnpm's
 * `NODE_PATH` hoist dir carries the workspace `sdk` link — a host property.
 */
async function linkRealSdk(dir: string): Promise<void> {
  const realSdk = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '../../node_modules/@kici-dev/sdk',
  );
  // pnpm may have hoisted the SDK higher up.
  let sdkTarget = realSdk;
  const { existsSync } = await import('node:fs');
  if (!existsSync(sdkTarget)) {
    let walk = path.dirname(fileURLToPath(import.meta.url));
    while (walk !== path.dirname(walk)) {
      const candidate = path.join(walk, 'node_modules', '@kici-dev', 'sdk');
      if (existsSync(candidate)) {
        sdkTarget = candidate;
        break;
      }
      walk = path.dirname(walk);
    }
  }
  const scopeDir = path.join(dir, 'node_modules', '@kici-dev');
  await fs.mkdir(scopeDir, { recursive: true });
  await fs.symlink(sdkTarget, path.join(scopeDir, 'sdk'));
}

beforeAll(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kici-wf-loader-'));

  await linkRealSdk(tempDir);
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

    expect(module.default).toBeDefined();
    expect(module.ci).toBeDefined();

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

    // Both sides hash the raw TS source, never the rolldown bundle, so SDK /
    // rolldown drift cannot split the compiler and agent hashes (compiler:
    // packages/compiler/src/execution/executor.ts loadModule).
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

  // Git for Windows sets `core.autocrlf=true` system-wide, so a clone writes
  // CRLF while the lock hashed LF source on Linux. Without normalization the
  // agent rejects every workflow with "lock file is out of date".
  it('accepts LF-computed contentHash even when source on disk has CRLF endings', async () => {
    const sourceFile = 'test-crlf-source.ts';
    const sourceCodeLf = `
import { workflow, job, step } from '@kici-dev/sdk';
export default workflow('crlf-test', {
  jobs: [job('j', { runsOn: 'linux', steps: [step('s', async () => {})] })],
});
`;
    const expectedHash = createHash('sha256')
      .update(`${COMPILE_SCHEMA_VERSION}:${sourceCodeLf}`)
      .digest('hex');

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

    const result = await extractStepsFromDynamicJob(workflow, 0, 'job-a', {}, {}, undefined, [
      'job-a',
      'job-b',
    ]);
    expect(result.steps).toHaveLength(1);
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
    // Job names come from the frozen members, so the snapshot must drive ctx.needs.
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

describe('resolveWorkflowSdkSetters', () => {
  let sdkDir: string;

  beforeAll(async () => {
    // A workflow tree whose @kici-dev/sdk is a stub recording its setter calls,
    // a different physical copy from the agent's bundled SDK.
    sdkDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kici-wf-sdk-'));
    const sdkPkgDir = path.join(sdkDir, 'node_modules', '@kici-dev', 'sdk');
    const sdkDistDir = path.join(sdkPkgDir, 'dist');
    await fs.mkdir(sdkDistDir, { recursive: true });
    await fs.writeFile(
      path.join(sdkPkgDir, 'package.json'),
      JSON.stringify({
        name: '@kici-dev/sdk',
        version: '0.0.0-stub',
        type: 'module',
        exports: {
          '.': { import: './dist/index.js', default: './dist/index.js' },
          './internal': { import: './dist/internal.js', default: './dist/internal.js' },
        },
      }),
      'utf-8',
    );
    // As in the published package, only the internal subpath carries setters.
    await fs.writeFile(
      path.join(sdkDistDir, 'index.js'),
      'export const __STUB__ = true;\n',
      'utf-8',
    );
    await fs.writeFile(
      path.join(sdkDistDir, 'internal.js'),
      `export function setStepOutputsMap(m) { globalThis.__stubStepMap = m; }
export function setStepRefMap(m) { globalThis.__stubRefMap = m; }
export function setJobOutputsMap(m) { globalThis.__stubJobMap = m; }
`,
      'utf-8',
    );
    await fs.mkdir(path.join(sdkDir, 'workflows'), { recursive: true });
    await fs.writeFile(path.join(sdkDir, 'workflows', 'wf.ts'), 'export default {};', 'utf-8');
  });

  afterAll(async () => {
    await fs.rm(sdkDir, { recursive: true, force: true }).catch(() => {});
    delete (globalThis as Record<string, unknown>).__stubStepMap;
    delete (globalThis as Record<string, unknown>).__stubRefMap;
    delete (globalThis as Record<string, unknown>).__stubJobMap;
  });

  it("resolves the workflow's own SDK instance from the workflow file context", async () => {
    const setters = await resolveWorkflowSdkSetters(path.join(sdkDir, 'workflows', 'wf.ts'));
    const stepMap = new Map();
    const refMap = new Map();
    const jobMap = new Map();
    setters.setStepOutputsMap(stepMap);
    setters.setStepRefMap(refMap);
    setters.setJobOutputsMap(jobMap);
    expect((globalThis as Record<string, unknown>).__stubStepMap).toBe(stepMap);
    expect((globalThis as Record<string, unknown>).__stubRefMap).toBe(refMap);
    expect((globalThis as Record<string, unknown>).__stubJobMap).toBe(jobMap);
  });

  // fails-when: the resolver falls back to the root barrel or to the agent's
  // bundled setters instead of refusing an SDK that predates the subpath
  it('refuses a tree whose SDK does not publish the internal subpath', async () => {
    const oldDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kici-wf-old-sdk-'));
    try {
      const pkgDir = path.join(oldDir, 'node_modules', '@kici-dev', 'sdk');
      await fs.mkdir(path.join(pkgDir, 'dist'), { recursive: true });
      await fs.writeFile(
        path.join(pkgDir, 'package.json'),
        JSON.stringify({
          name: '@kici-dev/sdk',
          version: '0.6.0',
          type: 'module',
          exports: { '.': { import: './dist/index.js', default: './dist/index.js' } },
        }),
        'utf-8',
      );
      // An SDK older than the subpath carried the setters on the root barrel.
      await fs.writeFile(
        path.join(pkgDir, 'dist', 'index.js'),
        `export function setStepOutputsMap() {}
export function setStepRefMap() {}
export function setJobOutputsMap() {}
`,
        'utf-8',
      );
      await fs.mkdir(path.join(oldDir, 'workflows'), { recursive: true });
      await fs.writeFile(path.join(oldDir, 'workflows', 'wf.ts'), 'export default {};', 'utf-8');

      await expect(
        resolveWorkflowSdkSetters(path.join(oldDir, 'workflows', 'wf.ts')),
      ).rejects.toThrow(/@kici-dev\/sdk@>=0\.8\.0/);
    } finally {
      await fs.rm(oldDir, { recursive: true, force: true }).catch(() => {});
    }
  });
});

describe('drift gate over the whole .kici/ tree', () => {
  let workDir: string;

  const entry = `
import { helper } from '../lib/helper.js';
export default { name: 'tree-gate', helper };
`;

  beforeEach(async () => {
    workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kici-tree-gate-'));
    await linkRealSdk(workDir);
    await fs.mkdir(path.join(workDir, '.kici/workflows'), { recursive: true });
    await fs.mkdir(path.join(workDir, '.kici/lib'), { recursive: true });
    await fs.writeFile(path.join(workDir, '.kici/workflows/w.ts'), entry, 'utf-8');
    await fs.writeFile(path.join(workDir, '.kici/lib/helper.ts'), 'export const helper = 1;\n');
  });

  afterEach(async () => {
    await fs.rm(workDir, { recursive: true, force: true });
  });

  /** What the compiler would have written into the lock for this tree. */
  async function lockHash(): Promise<string> {
    const digest = await hashKiciSourceTree(path.join(workDir, '.kici'));
    return createHash('sha256').update(`${COMPILE_SCHEMA_VERSION}:${digest}`).digest('hex');
  }

  it('passes when the extracted tree matches the lock', async () => {
    const { module } = await loadWorkflowSource(workDir, '.kici/workflows/w.ts', await lockHash());
    expect(module.default).toBeDefined();
  });

  it('rejects an edit to a NON-entry file', async () => {
    // fails-when: the gate hashes the entry file alone, so the stale helper
    // passes, hits the source cache, and the run reports green.
    const stale = await lockHash();
    await fs.writeFile(path.join(workDir, '.kici/lib/helper.ts'), 'export const helper = 2;\n');
    await expect(loadWorkflowSource(workDir, '.kici/workflows/w.ts', stale)).rejects.toThrow(
      /Lock file is out of date/,
    );
  });

  it('rejects a helper deleted after the lock was written', async () => {
    const stale = await lockHash();
    await fs.rm(path.join(workDir, '.kici/lib/helper.ts'));
    await expect(loadWorkflowSource(workDir, '.kici/workflows/w.ts', stale)).rejects.toThrow(
      /Lock file is out of date/,
    );
  });

  it('ignores .kici/node_modules, which ships in the deps tarball', async () => {
    const hash = await lockHash();
    await fs.mkdir(path.join(workDir, '.kici/node_modules/dep'), { recursive: true });
    await fs.writeFile(path.join(workDir, '.kici/node_modules/dep/i.js'), 'module.exports=1;\n');
    const { module } = await loadWorkflowSource(workDir, '.kici/workflows/w.ts', hash);
    expect(module.default).toBeDefined();
  });
});

describe('compile schema version gate', () => {
  let workDir: string;

  beforeEach(async () => {
    workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kici-schema-gate-'));
    await linkRealSdk(workDir);
    await fs.mkdir(path.join(workDir, '.kici/workflows'), { recursive: true });
    await fs.writeFile(
      path.join(workDir, '.kici/workflows/w.ts'),
      `export default { name: 'schema-gate' };\n`,
      'utf-8',
    );
  });

  afterEach(async () => {
    await fs.rm(workDir, { recursive: true, force: true });
  });

  /** Write a lock naming `compileSchemaVersion` for the one workflow. */
  async function writeLock(compileSchemaVersion: number): Promise<void> {
    await fs.writeFile(
      path.join(workDir, '.kici/kici.lock.json'),
      JSON.stringify({
        schemaVersion: 41,
        workflows: [
          {
            name: 'schema-gate',
            source: { file: '.kici/workflows/w.ts', export: 'default' },
            compileSchemaVersion,
          },
        ],
      }),
      'utf-8',
    );
  }

  async function lockHash(): Promise<string> {
    const digest = await hashKiciSourceTree(path.join(workDir, '.kici'));
    return createHash('sha256').update(`${COMPILE_SCHEMA_VERSION}:${digest}`).digest('hex');
  }

  it('names the version mismatch when the lock was compiled by a NEWER compiler', async () => {
    // fails-when: the agent reports "workflow source changed" and suggests
    // `kici compile`, which cannot fix a newer-schema lock.
    await writeLock(COMPILE_SCHEMA_VERSION + 1);
    const anyHash = 'a'.repeat(64);
    await expect(loadWorkflowSource(workDir, '.kici/workflows/w.ts', anyHash)).rejects.toThrow(
      /compiled by an incompatible @kici-dev\/compiler/,
    );
  });

  it('reports both versions and does NOT tell the operator to recompile', async () => {
    await writeLock(COMPILE_SCHEMA_VERSION + 1);
    const anyHash = 'a'.repeat(64);
    const err = await loadWorkflowSource(workDir, '.kici/workflows/w.ts', anyHash).catch(
      (e: Error) => e,
    );
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain(`compile schema ${COMPILE_SCHEMA_VERSION + 1}`);
    expect((err as Error).message).toContain(`agent implements ${COMPILE_SCHEMA_VERSION}`);
    expect((err as Error).message).not.toMatch(/Run 'kici compile'/);
  });

  it('names the mismatch when the lock was compiled by an OLDER compiler', async () => {
    await writeLock(COMPILE_SCHEMA_VERSION - 1);
    const anyHash = 'a'.repeat(64);
    await expect(loadWorkflowSource(workDir, '.kici/workflows/w.ts', anyHash)).rejects.toThrow(
      /compiled by an incompatible @kici-dev\/compiler/,
    );
  });

  it('still reports genuine source drift when the schema versions agree', async () => {
    await writeLock(COMPILE_SCHEMA_VERSION);
    const stale = 'b'.repeat(64);
    await expect(loadWorkflowSource(workDir, '.kici/workflows/w.ts', stale)).rejects.toThrow(
      /Lock file is out of date/,
    );
  });

  it('passes a matching tree whose lock names the agent’s own schema version', async () => {
    await writeLock(COMPILE_SCHEMA_VERSION);
    const { module } = await loadWorkflowSource(workDir, '.kici/workflows/w.ts', await lockHash());
    expect(module.default).toBeDefined();
  });

  it('falls through to the hash check when no lock file is present', async () => {
    const stale = 'c'.repeat(64);
    await expect(loadWorkflowSource(workDir, '.kici/workflows/w.ts', stale)).rejects.toThrow(
      /Lock file is out of date/,
    );
  });
});

import { describe, it, expect } from 'vitest';
import { detectWorkflowModifications } from './workflow-diff.js';
import type { LockFile, LockWorkflow } from '@kici-dev/engine';

// -- Helpers --

function makeLockFile(workflows: LockWorkflow[]): LockFile {
  return {
    schemaVersion: 9,
    source: { file: '.kici/workflows/ci.ts', export: '#default' },
    contentHash: 'deadbeef',
    workflows,
  };
}

function makeWorkflow(name: string, overrides?: Partial<LockWorkflow>): LockWorkflow {
  return {
    name,
    contentHash: 'abc123',
    compileSchemaVersion: 1,
    triggers: [
      {
        _type: 'push',
        branches: [{ type: 'glob', pattern: 'main' }],
        paths: [],
      },
    ],
    jobs: [
      {
        _type: 'static',
        name: 'build',
        runsOn: 'default',
        needs: [],
        steps: [{ name: 'install', hasOutputs: false }],
      },
    ],
    ...overrides,
  };
}

// -- Tests --

describe('detectWorkflowModifications', () => {
  it('returns empty for identical lock files', () => {
    const wf = makeWorkflow('ci');
    const base = makeLockFile([wf]);
    const head = makeLockFile([wf]);

    const result = detectWorkflowModifications(base, head);

    expect(result).toEqual([]);
  });

  it('detects new workflow added', () => {
    const base = makeLockFile([makeWorkflow('ci')]);
    const head = makeLockFile([makeWorkflow('ci'), makeWorkflow('deploy')]);

    const result = detectWorkflowModifications(base, head);

    expect(result).toEqual([{ workflowName: 'deploy', changeType: 'added' }]);
  });

  it('detects existing workflow removed', () => {
    const base = makeLockFile([makeWorkflow('ci'), makeWorkflow('deploy')]);
    const head = makeLockFile([makeWorkflow('ci')]);

    const result = detectWorkflowModifications(base, head);

    expect(result).toEqual([{ workflowName: 'deploy', changeType: 'removed' }]);
  });

  it('detects trigger modification', () => {
    const baseWf = makeWorkflow('ci', {
      triggers: [
        {
          _type: 'push',
          branches: [{ type: 'glob', pattern: 'main' }],
          paths: [],
        },
      ],
    });
    const headWf = makeWorkflow('ci', {
      triggers: [
        {
          _type: 'push',
          branches: [
            { type: 'glob', pattern: 'main' },
            { type: 'glob', pattern: 'develop' },
          ],
          paths: [],
        },
      ],
    });

    const base = makeLockFile([baseWf]);
    const head = makeLockFile([headWf]);

    const result = detectWorkflowModifications(base, head);

    expect(result).toEqual([{ workflowName: 'ci', changeType: 'modified' }]);
  });

  it('detects step modification', () => {
    const baseWf = makeWorkflow('ci', {
      jobs: [
        {
          _type: 'static',
          name: 'build',
          runsOn: 'default',
          needs: [],
          steps: [{ name: 'install', hasOutputs: false }],
        },
      ],
    });
    const headWf = makeWorkflow('ci', {
      jobs: [
        {
          _type: 'static',
          name: 'build',
          runsOn: 'default',
          needs: [],
          steps: [
            { name: 'install', hasOutputs: false },
            { name: 'test', hasOutputs: true },
          ],
        },
      ],
    });

    const base = makeLockFile([baseWf]);
    const head = makeLockFile([headWf]);

    const result = detectWorkflowModifications(base, head);

    expect(result).toEqual([{ workflowName: 'ci', changeType: 'modified' }]);
  });

  it('reports all workflows as added when base is null (new repo)', () => {
    const head = makeLockFile([makeWorkflow('ci'), makeWorkflow('deploy')]);

    const result = detectWorkflowModifications(null, head);

    expect(result).toEqual([
      { workflowName: 'ci', changeType: 'added' },
      { workflowName: 'deploy', changeType: 'added' },
    ]);
  });

  it('returns empty when head is null', () => {
    const base = makeLockFile([makeWorkflow('ci')]);

    const result = detectWorkflowModifications(base, null);

    expect(result).toEqual([]);
  });

  it('detects multiple changes simultaneously', () => {
    const base = makeLockFile([makeWorkflow('ci'), makeWorkflow('deploy'), makeWorkflow('lint')]);
    const head = makeLockFile([
      makeWorkflow('ci', {
        triggers: [
          {
            _type: 'pr',
            events: ['opened'],
            targetBranches: [],
            sourceBranches: [],
            paths: [],
          },
        ],
      }),
      // deploy removed
      makeWorkflow('e2e'), // e2e added
    ]);

    const result = detectWorkflowModifications(base, head);

    // ci modified, deploy removed, lint removed, e2e added
    expect(result).toContainEqual({ workflowName: 'ci', changeType: 'modified' });
    expect(result).toContainEqual({ workflowName: 'e2e', changeType: 'added' });
    expect(result).toContainEqual({ workflowName: 'deploy', changeType: 'removed' });
    expect(result).toContainEqual({ workflowName: 'lint', changeType: 'removed' });
    expect(result).toHaveLength(4);
  });

  it('does not flag unchanged workflows when contentHash differs', () => {
    // contentHash is volatile (changes with compile) -- we only compare triggers/jobs/rules
    const baseWf = makeWorkflow('ci');
    const headWf = makeWorkflow('ci');
    // Both have same triggers/jobs but different contentHash
    const base = makeLockFile([{ ...baseWf, contentHash: 'hash-v1' }]);
    const head = makeLockFile([{ ...headWf, contentHash: 'hash-v2' }]);

    const result = detectWorkflowModifications(base, head);

    expect(result).toEqual([]);
  });
});

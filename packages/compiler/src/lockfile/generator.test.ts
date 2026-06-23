import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  step,
  job,
  workflow,
  pr,
  push,
  tag,
  comment,
  review,
  reviewComment,
  release,
  dispatch,
  create,
  status,
  workflowRun,
  fork,
  star,
  watch,
  webhook,
  kiciEvent,
  workflowComplete,
  jobComplete,
  genericWebhook,
  rule,
} from '@kici-dev/sdk';
import * as sdk from '@kici-dev/sdk';

// delete is a reserved word -- access via namespace
const del = sdk['delete'];
import { generateLockFile, transformTriggers } from './generator.js';
import { computeContentHash, COMPILE_SCHEMA_VERSION } from './hasher.js';
import { SCHEMA_VERSION, type WorkflowWithSource } from '../types.js';

// Mock child_process to avoid git dependency in tests
vi.mock('node:child_process', () => ({
  execSync: vi.fn(() => '/mock/git/root'),
}));

const MOCK_ASSET_DIGEST = 'mock/file.txt\nmock content';
const MOCK_RESOLVED_PATHS = ['mock/file.txt'];

vi.mock('./hash-files.js', () => ({
  resolveHashFiles: vi.fn((_gitRoot: string, patterns: string[]) =>
    patterns.length ? { assetDigest: MOCK_ASSET_DIGEST, resolvedPaths: MOCK_RESOLVED_PATHS } : null,
  ),
}));

function makeWorkflowWithSource(
  w: ReturnType<typeof workflow>,
  bundleSource?: string,
): WorkflowWithSource {
  return {
    workflow: w,
    source: {
      file: '/mock/git/root/.kici/workflows/ci.ts',
      exportName: 'default',
    },
    bundleSource,
  };
}

describe('generator - approval config', () => {
  it('maps step requireApproval into LockStep.approval', () => {
    const s = step('deploy', { run: async () => {}, requireApproval: [{ team: 'leads' }] });
    const j = job('build', { runsOn: 'linux', steps: [s] });
    const w = workflow('ci', { jobs: [j] });
    const lockFile = generateLockFile([makeWorkflowWithSource(w)]);
    const lockJob = lockFile.workflows[0].jobs[0];
    if (lockJob._type === 'static') {
      expect(lockJob.steps[0].approval).toEqual({ clauses: [{ team: 'leads' }] });
    }
  });

  it('maps job requireApproval into LockJob.approval', () => {
    const j = job('deploy', { runsOn: 'linux', run: async () => {}, requireApproval: true });
    const w = workflow('ci', { jobs: [j] });
    const lockFile = generateLockFile([makeWorkflowWithSource(w)]);
    const lockJob = lockFile.workflows[0].jobs[0];
    if (lockJob._type === 'static') {
      expect(lockJob.approval).toEqual({ clauses: [] });
    }
  });

  it('maps workflow requireApproval (object form) into LockWorkflow.approval', () => {
    const j = job('build', { runsOn: 'linux', run: async () => {} });
    const w = workflow('ci', {
      jobs: [j],
      requireApproval: { approvers: [{ user: 'cto' }], reason: 'prod', timeout: 7200 },
    });
    const lockFile = generateLockFile([makeWorkflowWithSource(w)]);
    expect(lockFile.workflows[0].approval).toEqual({
      clauses: [{ user: 'cto' }],
      reason: 'prod',
      timeoutSeconds: 7200,
    });
  });
});

describe('generator - agent execution fields', () => {
  describe('step-level fields', () => {
    it('serializes continueOnError to LockStep', () => {
      const s = step('risky', {
        run: async () => {},
        continueOnError: true,
      });
      const j = job('build', { runsOn: 'linux', steps: [s] });
      const w = workflow('ci', { jobs: [j] });

      const lockFile = generateLockFile([makeWorkflowWithSource(w)]);
      const lockJob = lockFile.workflows[0].jobs[0];
      expect(lockJob._type).toBe('static');
      if (lockJob._type === 'static') {
        expect(lockJob.steps[0].continueOnError).toBe(true);
      }
    });

    it('serializes timeout to LockStep', () => {
      const s = step('slow', {
        run: async () => {},
        timeout: 60000,
      });
      const j = job('build', { runsOn: 'linux', steps: [s] });
      const w = workflow('ci', { jobs: [j] });

      const lockFile = generateLockFile([makeWorkflowWithSource(w)]);
      const lockJob = lockFile.workflows[0].jobs[0];
      if (lockJob._type === 'static') {
        expect(lockJob.steps[0].timeout).toBe(60000);
      }
    });

    it('serializes both continueOnError and timeout', () => {
      const s = step('configured', {
        run: async () => {},
        continueOnError: true,
        timeout: 120000,
      });
      const j = job('build', { runsOn: 'linux', steps: [s] });
      const w = workflow('ci', { jobs: [j] });

      const lockFile = generateLockFile([makeWorkflowWithSource(w)]);
      const lockJob = lockFile.workflows[0].jobs[0];
      if (lockJob._type === 'static') {
        expect(lockJob.steps[0].continueOnError).toBe(true);
        expect(lockJob.steps[0].timeout).toBe(120000);
      }
    });

    it('omits continueOnError and timeout when not set', () => {
      const s = step('simple', async () => {});
      const j = job('build', { runsOn: 'linux', steps: [s] });
      const w = workflow('ci', { jobs: [j] });

      const lockFile = generateLockFile([makeWorkflowWithSource(w)]);
      const lockJob = lockFile.workflows[0].jobs[0];
      if (lockJob._type === 'static') {
        expect(lockJob.steps[0]).not.toHaveProperty('continueOnError');
        expect(lockJob.steps[0]).not.toHaveProperty('timeout');
      }
    });
  });

  describe('job-level fields', () => {
    it('serializes checkout: false to LockJob', () => {
      const s = step('deploy', async () => {});
      const j = job('deploy', { runsOn: 'linux', steps: [s], checkout: false });
      const w = workflow('ci', { jobs: [j] });

      const lockFile = generateLockFile([makeWorkflowWithSource(w)]);
      const lockJob = lockFile.workflows[0].jobs[0];
      if (lockJob._type === 'static') {
        expect(lockJob.checkout).toBe(false);
      }
    });

    it('serializes container string to LockJob', () => {
      const s = step('build', async () => {});
      const j = job('build', {
        runsOn: 'linux',
        steps: [s],
        container: 'node:20-alpine',
      });
      const w = workflow('ci', { jobs: [j] });

      const lockFile = generateLockFile([makeWorkflowWithSource(w)]);
      const lockJob = lockFile.workflows[0].jobs[0];
      if (lockJob._type === 'static') {
        expect(lockJob.container).toBe('node:20-alpine');
      }
    });

    it('serializes container config object to LockJob', () => {
      const s = step('build', async () => {});
      const j = job('build', {
        runsOn: 'linux',
        steps: [s],
        container: { image: 'node:20', env: { NODE_ENV: 'ci' } },
      });
      const w = workflow('ci', { jobs: [j] });

      const lockFile = generateLockFile([makeWorkflowWithSource(w)]);
      const lockJob = lockFile.workflows[0].jobs[0];
      if (lockJob._type === 'static') {
        expect(lockJob.container).toEqual({ image: 'node:20', env: { NODE_ENV: 'ci' } });
      }
    });

    it('omits checkout and container when not set', () => {
      const s = step('build', async () => {});
      const j = job('build', { runsOn: 'linux', steps: [s] });
      const w = workflow('ci', { jobs: [j] });

      const lockFile = generateLockFile([makeWorkflowWithSource(w)]);
      const lockJob = lockFile.workflows[0].jobs[0];
      if (lockJob._type === 'static') {
        expect(lockJob).not.toHaveProperty('checkout');
        expect(lockJob).not.toHaveProperty('container');
      }
    });
  });

  describe('cache fields', () => {
    it('emits cache specs onto LockJob and LockStep', () => {
      const s = step('build', {
        run: async () => {},
        cache: [{ key: 's-k', paths: ['~/.cache'], restoreKeys: ['s-'] }],
      });
      const j = job('build', {
        runsOn: 'linux',
        steps: [s],
        cache: { key: 'job-k', paths: ['dist'] },
      });
      const w = workflow('ci', { jobs: [j] });

      const lockFile = generateLockFile([makeWorkflowWithSource(w)]);
      const lockJob = lockFile.workflows[0].jobs[0];
      expect(lockJob._type).toBe('static');
      if (lockJob._type === 'static') {
        expect(lockJob.cache).toEqual([{ key: 'job-k', paths: ['dist'] }]);
        expect(lockJob.steps[0].cache).toEqual([
          { key: 's-k', paths: ['~/.cache'], restoreKeys: ['s-'] },
        ]);
      }
    });

    it('omits cache when not set on job or step', () => {
      const s = step('build', async () => {});
      const j = job('build', { runsOn: 'linux', steps: [s] });
      const w = workflow('ci', { jobs: [j] });

      const lockFile = generateLockFile([makeWorkflowWithSource(w)]);
      const lockJob = lockFile.workflows[0].jobs[0];
      if (lockJob._type === 'static') {
        expect(lockJob).not.toHaveProperty('cache');
        expect(lockJob.steps[0]).not.toHaveProperty('cache');
      }
    });
  });

  describe('init field', () => {
    it('emits a single init config into the lock job', () => {
      const s = step('s', async () => {});
      const j = job('build', {
        runsOn: 'linux',
        steps: [s],
        init: { run: 'mise install', cache: { key: 'm', paths: ['~/.local/share/mise'] } },
      });
      const w = workflow('w', { jobs: [j] });

      const lockFile = generateLockFile([makeWorkflowWithSource(w)]);
      const lockJob = lockFile.workflows[0].jobs[0];
      expect(lockJob._type).toBe('static');
      if (lockJob._type === 'static') {
        expect(lockJob.init).toEqual({
          run: 'mise install',
          cache: { key: 'm', paths: ['~/.local/share/mise'] },
        });
      }
    });

    it('emits an array of init configs preserving order', () => {
      const s = step('s', async () => {});
      const j = job('build', {
        runsOn: 'linux',
        steps: [s],
        init: [{ run: 'a' }, { run: 'b' }],
      });
      const w = workflow('w', { jobs: [j] });

      const lockFile = generateLockFile([makeWorkflowWithSource(w)]);
      const lockJob = lockFile.workflows[0].jobs[0];
      if (lockJob._type === 'static') {
        expect(lockJob.init).toEqual([{ run: 'a' }, { run: 'b' }]);
      }
    });

    it('emits init: false', () => {
      const s = step('s', async () => {});
      const j = job('build', { runsOn: 'linux', steps: [s], init: false });
      const w = workflow('w', { jobs: [j] });

      const lockFile = generateLockFile([makeWorkflowWithSource(w)]);
      const lockJob = lockFile.workflows[0].jobs[0];
      if (lockJob._type === 'static') {
        expect(lockJob.init).toBe(false);
      }
    });

    it('serializes a string preset into the lock job', () => {
      const s = step('s', async () => {});
      const j = job('build', { runsOn: 'linux', steps: [s], init: 'mise' });
      const w = workflow('w', { jobs: [j] });

      const lockFile = generateLockFile([makeWorkflowWithSource(w)]);
      const lockJob = lockFile.workflows[0].jobs[0];
      if (lockJob._type === 'static') {
        expect(lockJob.init).toBe('mise');
      }
    });

    it('serializes an object preset into the lock job', () => {
      const s = step('s', async () => {});
      const j = job('build', {
        runsOn: 'linux',
        steps: [s],
        init: { mise: { timeout: 300_000, cache: false } },
      });
      const w = workflow('w', { jobs: [j] });

      const lockFile = generateLockFile([makeWorkflowWithSource(w)]);
      const lockJob = lockFile.workflows[0].jobs[0];
      if (lockJob._type === 'static') {
        expect(lockJob.init).toEqual({ mise: { timeout: 300_000, cache: false } });
      }
    });

    it('serializes auto into the lock job', () => {
      const s = step('s', async () => {});
      const j = job('build', { runsOn: 'linux', steps: [s], init: 'auto' });
      const w = workflow('w', { jobs: [j] });

      const lockFile = generateLockFile([makeWorkflowWithSource(w)]);
      const lockJob = lockFile.workflows[0].jobs[0];
      if (lockJob._type === 'static') {
        expect(lockJob.init).toBe('auto');
      }
    });

    it('omits init when not set', () => {
      const s = step('s', async () => {});
      const j = job('build', { runsOn: 'linux', steps: [s] });
      const w = workflow('w', { jobs: [j] });

      const lockFile = generateLockFile([makeWorkflowWithSource(w)]);
      const lockJob = lockFile.workflows[0].jobs[0];
      if (lockJob._type === 'static') {
        expect(lockJob).not.toHaveProperty('init');
      }
    });
  });
});

describe('generator - content hash fields', () => {
  it('includes contentHash and compileSchemaVersion when bundleSource is provided', () => {
    const s = step('build', async () => {});
    const j = job('build', { runsOn: 'linux', steps: [s] });
    const w = workflow('ci', { jobs: [j] });

    const lockFile = generateLockFile([makeWorkflowWithSource(w, 'const x = 1;')]);
    const lockWorkflow = lockFile.workflows[0];

    expect(lockWorkflow.contentHash).toMatch(/^[0-9a-f]{64}$/);
    expect(lockWorkflow.compileSchemaVersion).toBe(COMPILE_SCHEMA_VERSION);
  });

  it('uses empty contentHash and 0 compileSchemaVersion when bundleSource is absent', () => {
    const s = step('build', async () => {});
    const j = job('build', { runsOn: 'linux', steps: [s] });
    const w = workflow('ci', { jobs: [j] });

    const lockFile = generateLockFile([makeWorkflowWithSource(w)]);
    const lockWorkflow = lockFile.workflows[0];

    expect(lockWorkflow.contentHash).toBe('');
    expect(lockWorkflow.compileSchemaVersion).toBe(0);
  });

  it('produces deterministic hashes for the same bundleSource', () => {
    const s = step('build', async () => {});
    const j = job('build', { runsOn: 'linux', steps: [s] });
    const w = workflow('ci', { jobs: [j] });

    const lockFile1 = generateLockFile([makeWorkflowWithSource(w, 'const x = 42;')]);
    const lockFile2 = generateLockFile([makeWorkflowWithSource(w, 'const x = 42;')]);

    expect(lockFile1.workflows[0].contentHash).toBe(lockFile2.workflows[0].contentHash);
  });

  it('produces different hashes for different bundleSources', () => {
    const s = step('build', async () => {});
    const j = job('build', { runsOn: 'linux', steps: [s] });
    const w = workflow('ci', { jobs: [j] });

    const lockFile1 = generateLockFile([makeWorkflowWithSource(w, 'const a = 1;')]);
    const lockFile2 = generateLockFile([makeWorkflowWithSource(w, 'const b = 2;')]);

    expect(lockFile1.workflows[0].contentHash).not.toBe(lockFile2.workflows[0].contentHash);
  });

  it('schemaVersion is 21', () => {
    const s = step('build', async () => {});
    const j = job('build', { runsOn: 'linux', steps: [s] });
    const w = workflow('ci', { jobs: [j] });

    const lockFile = generateLockFile([makeWorkflowWithSource(w)]);
    expect(lockFile.schemaVersion).toBe(21);
    expect(SCHEMA_VERSION).toBe(21);
  });
});

describe('generator - top-level contentHash', () => {
  it('includes a 64-char hex contentHash instead of generatedAt', () => {
    const s = step('build', async () => {});
    const j = job('build', { runsOn: 'linux', steps: [s] });
    const w = workflow('ci', { jobs: [j] });

    const lockFile = generateLockFile([makeWorkflowWithSource(w)]);
    expect(lockFile.contentHash).toMatch(/^[0-9a-f]{64}$/);
    expect(lockFile).not.toHaveProperty('generatedAt');
  });

  it('is deterministic: same input produces same hash', () => {
    const s = step('build', async () => {});
    const j = job('build', { runsOn: 'linux', steps: [s] });
    const w = workflow('ci', { jobs: [j] });

    const lockFile1 = generateLockFile([makeWorkflowWithSource(w)]);
    const lockFile2 = generateLockFile([makeWorkflowWithSource(w)]);
    expect(lockFile1.contentHash).toBe(lockFile2.contentHash);
  });

  it('changes when workflow structure changes', () => {
    const s1 = step('build', async () => {});
    const j1 = job('build', { runsOn: 'linux', steps: [s1] });
    const w1 = workflow('ci', { jobs: [j1] });

    const s2 = step('test', async () => {});
    const j2 = job('test', { runsOn: 'linux', steps: [s2] });
    const w2 = workflow('ci', { jobs: [j2] });

    const hash1 = generateLockFile([makeWorkflowWithSource(w1)]).contentHash;
    const hash2 = generateLockFile([makeWorkflowWithSource(w2)]).contentHash;
    expect(hash1).not.toBe(hash2);
  });

  it('changes when bundle hash changes', () => {
    const s = step('build', async () => {});
    const j = job('build', { runsOn: 'linux', steps: [s] });
    const w = workflow('ci', { jobs: [j] });

    const hash1 = generateLockFile([makeWorkflowWithSource(w, 'const a = 1;')]).contentHash;
    const hash2 = generateLockFile([makeWorkflowWithSource(w, 'const b = 2;')]).contentHash;
    expect(hash1).not.toBe(hash2);
  });

  it('does not change across invocations with same content', () => {
    const s = step('build', async () => {});
    const j = job('build', { runsOn: 'linux', steps: [s] });
    const w = workflow('ci', { jobs: [j] });

    const hash1 = generateLockFile([makeWorkflowWithSource(w, 'const x = 42;')]).contentHash;
    const hash2 = generateLockFile([makeWorkflowWithSource(w, 'const x = 42;')]).contentHash;
    expect(hash1).toBe(hash2);
  });
});

describe('generator - contexts removal', () => {
  it('omits contexts from lock file workflows (contexts removed in v6)', () => {
    const s = step('build', async () => {});
    const j = job('build', { runsOn: 'linux', steps: [s] });
    const w = workflow('ci', { jobs: [j] });

    const lockFile = generateLockFile([makeWorkflowWithSource(w)]);
    const lockWorkflow = lockFile.workflows[0];

    expect(lockWorkflow).not.toHaveProperty('contexts');
  });
});

describe('generator - registries and installEnv', () => {
  const makeBasicJob = () => job('build', { runsOn: 'linux', steps: [step('s', async () => {})] });

  it('emits registries: into the lock file when the workflow declares them', () => {
    const w = workflow('ci', {
      jobs: [makeBasicJob()],
      registries: [
        {
          url: 'https://npm.pkg.github.com',
          scope: '@my-org',
          tokenSecret: 'production:GITHUB_PACKAGES_TOKEN',
        },
      ],
    });
    const lockFile = generateLockFile([makeWorkflowWithSource(w, 'const x = 1;')]);
    const lockWorkflow = lockFile.workflows[0];

    expect(lockWorkflow.registries).toEqual([
      {
        url: 'https://npm.pkg.github.com',
        scope: '@my-org',
        tokenSecret: 'production:GITHUB_PACKAGES_TOKEN',
      },
    ]);
  });

  it('emits installEnv: as a plain string array', () => {
    const w = workflow('ci', {
      jobs: [makeBasicJob()],
      installEnv: ['production:NPM_TOKEN', 'shared:CA_BUNDLE'],
    });
    const lockFile = generateLockFile([makeWorkflowWithSource(w, 'const x = 1;')]);
    const lockWorkflow = lockFile.workflows[0];

    expect(lockWorkflow.installEnv).toEqual(['production:NPM_TOKEN', 'shared:CA_BUNDLE']);
  });

  it('omits both fields entirely when undeclared', () => {
    const w = workflow('ci', { jobs: [makeBasicJob()] });
    const lockFile = generateLockFile([makeWorkflowWithSource(w, 'const x = 1;')]);
    const lockWorkflow = lockFile.workflows[0];

    expect(lockWorkflow).not.toHaveProperty('registries');
    expect(lockWorkflow).not.toHaveProperty('installEnv');
  });

  it('emits workflow-level timeout into the lock file', () => {
    const w = workflow('ci', { jobs: [makeBasicJob()], timeout: 1_800_000 });
    const lockFile = generateLockFile([makeWorkflowWithSource(w, 'const x = 1;')]);

    expect(lockFile.workflows[0].timeout).toBe(1_800_000);
  });

  it('omits workflow-level timeout when not set', () => {
    const w = workflow('ci', { jobs: [makeBasicJob()] });
    const lockFile = generateLockFile([makeWorkflowWithSource(w, 'const x = 1;')]);

    expect(lockFile.workflows[0]).not.toHaveProperty('timeout');
  });

  it('preserves the alwaysAuth flag when set', () => {
    const w = workflow('ci', {
      jobs: [makeBasicJob()],
      registries: [
        {
          url: 'https://npm.pkg.github.com',
          scope: '@my-org',
          tokenSecret: 'production:T',
          alwaysAuth: false,
        },
      ],
    });
    const lockFile = generateLockFile([makeWorkflowWithSource(w, 'const x = 1;')]);
    expect(lockFile.workflows[0].registries![0].alwaysAuth).toBe(false);
  });

  it('changes the lockfile contentHash when registries change', () => {
    const baseline = workflow('ci', { jobs: [makeBasicJob()] });
    const withRegistry = workflow('ci', {
      jobs: [makeBasicJob()],
      registries: [{ url: 'https://npm.pkg.github.com', tokenSecret: 'production:T' }],
    });

    const a = generateLockFile([makeWorkflowWithSource(baseline, 'const x = 1;')]).contentHash;
    const b = generateLockFile([makeWorkflowWithSource(withRegistry, 'const x = 1;')]).contentHash;
    expect(a).not.toBe(b);
  });
});

describe('generator - hashFiles', () => {
  it('includes hashFiles and resolvedHashFiles when workflow has hashFiles', () => {
    const s = step('build', async () => {});
    const j = job('build', { runsOn: 'linux', steps: [s] });
    const w = workflow('ci', { jobs: [j], hashFiles: ['mock/file.txt'] });
    const bundleSource = 'const x = 1;';
    const lockFile = generateLockFile([makeWorkflowWithSource(w, bundleSource)]);
    const lockWorkflow = lockFile.workflows[0];

    expect(lockWorkflow.hashFiles).toEqual(['mock/file.txt']);
    expect(lockWorkflow.resolvedHashFiles).toEqual(MOCK_RESOLVED_PATHS);
    expect(lockWorkflow.contentHash).toBe(
      computeContentHash(bundleSource, COMPILE_SCHEMA_VERSION, MOCK_ASSET_DIGEST),
    );
  });

  it('backward compat: no hashFiles on workflow omits hashFiles and resolvedHashFiles from lock', () => {
    const s = step('build', async () => {});
    const j = job('build', { runsOn: 'linux', steps: [s] });
    const w = workflow('ci', { jobs: [j] });
    const lockFile = generateLockFile([makeWorkflowWithSource(w, 'const x = 1;')]);
    const lockWorkflow = lockFile.workflows[0];

    expect(lockWorkflow).not.toHaveProperty('hashFiles');
    expect(lockWorkflow).not.toHaveProperty('resolvedHashFiles');
    expect(lockWorkflow.contentHash).toBe(
      computeContentHash('const x = 1;', COMPILE_SCHEMA_VERSION),
    );
  });
});

describe('generator - source locations', () => {
  it('propagates _sourceLocation to sourceLocation when present', () => {
    const s = step('build', async () => {});
    // Inject a mock _sourceLocation (step() captures real ones, but we want deterministic tests)
    const sWithLoc = {
      ...s,
      _sourceLocation: {
        file: '/mock/git/root/src/ci.ts',
        line: 42,
        column: 5,
      },
    };
    const j = job('build', { runsOn: 'linux', steps: [sWithLoc] });
    const w = workflow('ci', { jobs: [j] });

    const lockFile = generateLockFile([makeWorkflowWithSource(w)]);
    const lockJob = lockFile.workflows[0].jobs[0];
    if (lockJob._type === 'static') {
      expect(lockJob.steps[0].sourceLocation).toEqual({
        file: 'src/ci.ts',
        line: 42,
        column: 5,
      });
    }
  });

  it('omits sourceLocation when _sourceLocation is undefined (backward compat)', () => {
    const s = step('build', async () => {});
    // Override _sourceLocation to undefined to ensure backward compat
    const sNoLoc = { ...s, _sourceLocation: undefined };
    const j = job('build', { runsOn: 'linux', steps: [sNoLoc] });
    const w = workflow('ci', { jobs: [j] });

    const lockFile = generateLockFile([makeWorkflowWithSource(w)]);
    const lockJob = lockFile.workflows[0].jobs[0];
    if (lockJob._type === 'static') {
      expect(lockJob.steps[0]).not.toHaveProperty('sourceLocation');
    }
  });

  it('makes file path relative to git root', () => {
    const s = step('test', async () => {});
    const sWithAbsLoc = {
      ...s,
      _sourceLocation: {
        file: '/mock/git/root/.kici/workflows/ci.ts',
        line: 10,
        column: 3,
      },
    };
    const j = job('test', { runsOn: 'linux', steps: [sWithAbsLoc] });
    const w = workflow('ci', { jobs: [j] });

    const lockFile = generateLockFile([makeWorkflowWithSource(w)]);
    const lockJob = lockFile.workflows[0].jobs[0];
    if (lockJob._type === 'static') {
      expect(lockJob.steps[0].sourceLocation?.file).toBe('.kici/workflows/ci.ts');
    }
  });

  it('strips .compiled.mjs?t=... suffix from sourceLocation file paths', () => {
    const s = step('build', async () => {});
    const sWithCompiledLoc = {
      ...s,
      _sourceLocation: {
        file: '/mock/git/root/.kici/workflows/ci.ts.compiled.mjs?t=1772248448578',
        line: 10,
        column: 3,
      },
    };
    const j = job('build', { runsOn: 'linux', steps: [sWithCompiledLoc] });
    const w = workflow('ci', { jobs: [j] });

    const lockFile = generateLockFile([makeWorkflowWithSource(w)]);
    const lockJob = lockFile.workflows[0].jobs[0];
    if (lockJob._type === 'static') {
      expect(lockJob.steps[0].sourceLocation?.file).toBe('.kici/workflows/ci.ts');
    }
  });

  it('produces deterministic contentHash regardless of cache-buster timestamp', () => {
    const s = step('build', async () => {});
    const sWithLoc1 = {
      ...s,
      _sourceLocation: {
        file: '/mock/git/root/.kici/workflows/ci.ts.compiled.mjs?t=1111111111111',
        line: 10,
        column: 3,
      },
    };
    const sWithLoc2 = {
      ...s,
      _sourceLocation: {
        file: '/mock/git/root/.kici/workflows/ci.ts.compiled.mjs?t=9999999999999',
        line: 10,
        column: 3,
      },
    };

    const j1 = job('build', { runsOn: 'linux', steps: [sWithLoc1] });
    const w1 = workflow('ci', { jobs: [j1] });
    const j2 = job('build', { runsOn: 'linux', steps: [sWithLoc2] });
    const w2 = workflow('ci', { jobs: [j2] });

    const hash1 = generateLockFile([makeWorkflowWithSource(w1)]).contentHash;
    const hash2 = generateLockFile([makeWorkflowWithSource(w2)]).contentHash;
    expect(hash1).toBe(hash2);
  });

  it('step() factory captures real _sourceLocation with file, line, column', () => {
    const s = step('real', async () => {});
    expect(s._sourceLocation).toBeDefined();
    expect(s._sourceLocation!.file).toContain('generator.test');
    expect(typeof s._sourceLocation!.line).toBe('number');
    expect(typeof s._sourceLocation!.column).toBe('number');
    expect(s._sourceLocation!.line).toBeGreaterThan(0);
    expect(s._sourceLocation!.column).toBeGreaterThan(0);
  });
});

describe('generator - new trigger types', () => {
  function makeTriggerWorkflow(triggers: any[]): WorkflowWithSource {
    const s = step('build', async () => {});
    const j = job('build', { runsOn: 'linux', steps: [s] });
    const w = workflow('ci', { on: triggers, jobs: [j] });
    return makeWorkflowWithSource(w);
  }

  it('transforms TagTrigger to LockTagTrigger', () => {
    const lockFile = generateLockFile([makeTriggerWorkflow([tag({ patterns: 'v*' })])]);
    const t = lockFile.workflows[0].triggers[0];
    expect(t._type).toBe('tag');
    if (t._type === 'tag') {
      expect(t.patterns).toEqual([{ type: 'glob', pattern: 'v*' }]);
    }
  });

  it('transforms CommentTrigger to LockCommentTrigger', () => {
    const lockFile = generateLockFile([
      makeTriggerWorkflow([comment({ actions: ['created'], source: 'pr', bodyMatch: '/deploy' })]),
    ]);
    const t = lockFile.workflows[0].triggers[0];
    expect(t._type).toBe('comment');
    if (t._type === 'comment') {
      expect(t.actions).toEqual(['created']);
      expect(t.source).toBe('pr');
      expect(t.bodyMatch).toEqual({ type: 'glob', pattern: '/deploy' });
    }
  });

  it('transforms ReviewTrigger to LockReviewTrigger', () => {
    const lockFile = generateLockFile([
      makeTriggerWorkflow([review({ actions: ['submitted'], states: ['approved'] })]),
    ]);
    const t = lockFile.workflows[0].triggers[0];
    expect(t._type).toBe('review');
    if (t._type === 'review') {
      expect(t.actions).toEqual(['submitted']);
      expect(t.states).toEqual(['approved']);
    }
  });

  it('transforms ReviewCommentTrigger to LockReviewCommentTrigger', () => {
    const lockFile = generateLockFile([
      makeTriggerWorkflow([reviewComment({ actions: ['created'] })]),
    ]);
    const t = lockFile.workflows[0].triggers[0];
    expect(t._type).toBe('review_comment');
    if (t._type === 'review_comment') {
      expect(t.actions).toEqual(['created']);
    }
  });

  it('transforms ReleaseTrigger to LockReleaseTrigger', () => {
    const lockFile = generateLockFile([makeTriggerWorkflow([release({ actions: ['published'] })])]);
    const t = lockFile.workflows[0].triggers[0];
    expect(t._type).toBe('release');
    if (t._type === 'release') {
      expect(t.actions).toEqual(['published']);
    }
  });

  it('transforms DispatchTrigger to LockDispatchTrigger', () => {
    const lockFile = generateLockFile([
      makeTriggerWorkflow([dispatch({ types: ['deploy', 'rollback'] })]),
    ]);
    const t = lockFile.workflows[0].triggers[0];
    expect(t._type).toBe('dispatch');
    if (t._type === 'dispatch') {
      expect(t.types).toEqual(['deploy', 'rollback']);
    }
  });

  it('transforms CreateTrigger to LockCreateTrigger', () => {
    const lockFile = generateLockFile([
      makeTriggerWorkflow([create({ refTypes: ['branch'], patterns: 'feature/*' })]),
    ]);
    const t = lockFile.workflows[0].triggers[0];
    expect(t._type).toBe('create');
    if (t._type === 'create') {
      expect(t.refTypes).toEqual(['branch']);
      expect(t.patterns).toEqual([{ type: 'glob', pattern: 'feature/*' }]);
    }
  });

  it('transforms DeleteTrigger to LockDeleteTrigger', () => {
    const lockFile = generateLockFile([
      makeTriggerWorkflow([del({ refTypes: ['branch'], patterns: 'feature/*' })]),
    ]);
    const t = lockFile.workflows[0].triggers[0];
    expect(t._type).toBe('delete');
    if (t._type === 'delete') {
      expect(t.refTypes).toEqual(['branch']);
      expect(t.patterns).toEqual([{ type: 'glob', pattern: 'feature/*' }]);
    }
  });

  it('transforms StatusTrigger to LockStatusTrigger', () => {
    const lockFile = generateLockFile([
      makeTriggerWorkflow([status({ contexts: ['ci/test'], states: ['success'] })]),
    ]);
    const t = lockFile.workflows[0].triggers[0];
    expect(t._type).toBe('status');
    if (t._type === 'status') {
      expect(t.contexts).toEqual(['ci/test']);
      expect(t.states).toEqual(['success']);
    }
  });

  it('transforms WorkflowRunTrigger to LockWorkflowRunTrigger', () => {
    const lockFile = generateLockFile([
      makeTriggerWorkflow([
        workflowRun({
          actions: ['completed'],
          workflows: ['CI'],
          conclusions: ['success'],
        }),
      ]),
    ]);
    const t = lockFile.workflows[0].triggers[0];
    expect(t._type).toBe('workflow_run');
    if (t._type === 'workflow_run') {
      expect(t.actions).toEqual(['completed']);
      expect(t.workflows).toEqual(['CI']);
      expect(t.conclusions).toEqual(['success']);
    }
  });

  it('transforms ForkTrigger to LockForkTrigger', () => {
    const lockFile = generateLockFile([makeTriggerWorkflow([fork()])]);
    const t = lockFile.workflows[0].triggers[0];
    expect(t._type).toBe('fork');
  });

  it('transforms StarTrigger to LockStarTrigger', () => {
    const lockFile = generateLockFile([makeTriggerWorkflow([star({ actions: ['created'] })])]);
    const t = lockFile.workflows[0].triggers[0];
    expect(t._type).toBe('star');
    if (t._type === 'star') {
      expect(t.actions).toEqual(['created']);
    }
  });

  it('transforms WatchTrigger to LockWatchTrigger', () => {
    const lockFile = generateLockFile([makeTriggerWorkflow([watch({ actions: ['started'] })])]);
    const t = lockFile.workflows[0].triggers[0];
    expect(t._type).toBe('watch');
    if (t._type === 'watch') {
      expect(t.actions).toEqual(['started']);
    }
  });

  it('transforms WebhookTrigger to LockWebhookTrigger', () => {
    const lockFile = generateLockFile([
      makeTriggerWorkflow([webhook({ events: ['deployment'], actions: ['created'] })]),
    ]);
    const t = lockFile.workflows[0].triggers[0];
    expect(t._type).toBe('webhook');
    if (t._type === 'webhook') {
      expect(t.events).toEqual(['deployment']);
      expect(t.actions).toEqual(['created']);
    }
  });

  it('push with tags generates both LockPushTrigger and LockTagTrigger', () => {
    const lockFile = generateLockFile([
      makeTriggerWorkflow([push({ branches: 'main', tags: 'v*' })]),
    ]);
    const triggers = lockFile.workflows[0].triggers;
    expect(triggers).toHaveLength(2);
    expect(triggers[0]._type).toBe('push');
    expect(triggers[1]._type).toBe('tag');
    if (triggers[1]._type === 'tag') {
      expect(triggers[1].patterns).toEqual([{ type: 'glob', pattern: 'v*' }]);
    }
  });

  it('push without tags generates only LockPushTrigger', () => {
    const lockFile = generateLockFile([makeTriggerWorkflow([push({ branches: 'main' })])]);
    const triggers = lockFile.workflows[0].triggers;
    expect(triggers).toHaveLength(1);
    expect(triggers[0]._type).toBe('push');
  });

  it('comment with regex bodyMatch serializes correctly', () => {
    const lockFile = generateLockFile([
      makeTriggerWorkflow([comment({ bodyMatch: /^\/deploy/i })]),
    ]);
    const t = lockFile.workflows[0].triggers[0];
    if (t._type === 'comment') {
      expect(t.bodyMatch).toEqual({ type: 'regex', pattern: '^\\/deploy', flags: 'i' });
    }
  });

  it('transforms KiciEventTrigger to LockKiciEventTrigger', () => {
    const lockFile = generateLockFile([
      makeTriggerWorkflow([kiciEvent({ name: 'deploy-complete', match: { '$.env': 'prod' } })]),
    ]);
    const t = lockFile.workflows[0].triggers[0];
    expect(t._type).toBe('kici_event');
    if (t._type === 'kici_event') {
      expect(t.eventName).toBe('deploy-complete');
      expect(t.match).toEqual({ '$.env': 'prod' });
    }
  });

  it('transforms KiciEventTrigger with all optional fields', () => {
    const lockFile = generateLockFile([
      makeTriggerWorkflow([
        kiciEvent({
          name: 'deploy-complete',
          match: { '$.env': 'prod' },
          not: { '$.dry_run': true },
          source: 'org/infra-repo',
        }),
      ]),
    ]);
    const t = lockFile.workflows[0].triggers[0];
    if (t._type === 'kici_event') {
      expect(t.eventName).toBe('deploy-complete');
      expect(t.match).toEqual({ '$.env': 'prod' });
      expect(t.not).toEqual({ '$.dry_run': true });
      expect(t.source).toBe('org/infra-repo');
    }
  });

  it('transforms KiciEventTrigger omitting undefined optional fields', () => {
    const lockFile = generateLockFile([makeTriggerWorkflow([kiciEvent({ name: 'test-event' })])]);
    const t = lockFile.workflows[0].triggers[0];
    if (t._type === 'kici_event') {
      expect(t.eventName).toBe('test-event');
      expect(t).not.toHaveProperty('match');
      expect(t).not.toHaveProperty('not');
      expect(t).not.toHaveProperty('source');
    }
  });

  it('transforms WorkflowCompleteTrigger to LockWorkflowCompleteTrigger', () => {
    const lockFile = generateLockFile([
      makeTriggerWorkflow([workflowComplete({ name: 'CI', status: ['success'] })]),
    ]);
    const t = lockFile.workflows[0].triggers[0];
    expect(t._type).toBe('workflow_complete');
    if (t._type === 'workflow_complete') {
      expect(t.name).toBe('CI');
      expect(t.status).toEqual(['success']);
    }
  });

  it('transforms WorkflowCompleteTrigger omitting undefined optional fields', () => {
    const lockFile = generateLockFile([makeTriggerWorkflow([workflowComplete()])]);
    const t = lockFile.workflows[0].triggers[0];
    if (t._type === 'workflow_complete') {
      expect(t).not.toHaveProperty('name');
      expect(t).not.toHaveProperty('status');
      expect(t).not.toHaveProperty('source');
    }
  });

  it('transforms JobCompleteTrigger to LockJobCompleteTrigger', () => {
    const lockFile = generateLockFile([
      makeTriggerWorkflow([jobComplete({ workflow: 'CI', job: 'build' })]),
    ]);
    const t = lockFile.workflows[0].triggers[0];
    expect(t._type).toBe('job_complete');
    if (t._type === 'job_complete') {
      expect(t.workflow).toBe('CI');
      expect(t.job).toBe('build');
    }
  });

  it('transforms JobCompleteTrigger with status and source', () => {
    const lockFile = generateLockFile([
      makeTriggerWorkflow([
        jobComplete({
          workflow: 'CI',
          job: 'build',
          status: ['success', 'failed'],
          source: 'org/repo',
        }),
      ]),
    ]);
    const t = lockFile.workflows[0].triggers[0];
    if (t._type === 'job_complete') {
      expect(t.workflow).toBe('CI');
      expect(t.job).toBe('build');
      expect(t.status).toEqual(['success', 'failed']);
      expect(t.source).toBe('org/repo');
    }
  });

  it('transforms JobCompleteTrigger omitting undefined optional fields', () => {
    const lockFile = generateLockFile([makeTriggerWorkflow([jobComplete()])]);
    const t = lockFile.workflows[0].triggers[0];
    if (t._type === 'job_complete') {
      expect(t).not.toHaveProperty('workflow');
      expect(t).not.toHaveProperty('job');
      expect(t).not.toHaveProperty('status');
      expect(t).not.toHaveProperty('source');
    }
  });

  it('transforms GenericWebhookTrigger to LockGenericWebhookTrigger', () => {
    const lockFile = generateLockFile([
      makeTriggerWorkflow([genericWebhook({ source: 'my-service', events: ['deploy'] })]),
    ]);
    const t = lockFile.workflows[0].triggers[0];
    expect(t._type).toBe('generic_webhook');
    if (t._type === 'generic_webhook') {
      expect(t.source).toBe('my-service');
      expect(t.events).toEqual(['deploy']);
    }
  });

  it('transforms GenericWebhookTrigger with match/not filters', () => {
    const lockFile = generateLockFile([
      makeTriggerWorkflow([
        genericWebhook({
          source: 'my-service',
          events: ['deploy'],
          match: { '$.env': 'prod' },
          not: { '$.dry_run': true },
        }),
      ]),
    ]);
    const t = lockFile.workflows[0].triggers[0];
    if (t._type === 'generic_webhook') {
      expect(t.source).toBe('my-service');
      expect(t.events).toEqual(['deploy']);
      expect(t.match).toEqual({ '$.env': 'prod' });
      expect(t.not).toEqual({ '$.dry_run': true });
    }
  });

  it('transforms GenericWebhookTrigger omitting undefined optional fields', () => {
    const lockFile = generateLockFile([
      makeTriggerWorkflow([genericWebhook({ source: 'my-service' })]),
    ]);
    const t = lockFile.workflows[0].triggers[0];
    if (t._type === 'generic_webhook') {
      expect(t.source).toBe('my-service');
      expect(t).not.toHaveProperty('events');
      expect(t).not.toHaveProperty('match');
      expect(t).not.toHaveProperty('not');
    }
  });
});

describe('generator - auto-IDs and bare function normalization', () => {
  describe('step auto-IDs', () => {
    it('assigns step-N names to bare function steps', () => {
      const bareFn1 = async () => {};
      const bareFn2 = async () => {};
      const j = job('build', { runsOn: 'linux', steps: [bareFn1, bareFn2] });
      const w = workflow('ci', { jobs: [j] });

      const lockFile = generateLockFile([makeWorkflowWithSource(w)]);
      const lockJob = lockFile.workflows[0].jobs[0];
      if (lockJob._type === 'static') {
        expect(lockJob.steps[0].name).toBe('step-1');
        expect(lockJob.steps[1].name).toBe('step-2');
        expect(lockJob.steps[0].hasOutputs).toBe(false);
        expect(lockJob.steps[1].hasOutputs).toBe(false);
      }
    });

    it('assigns step-N names to id-less steps (empty name)', () => {
      const s1 = step(async () => {});
      const s2 = step(async () => {});
      const j = job('build', { runsOn: 'linux', steps: [s1, s2] });
      const w = workflow('ci', { jobs: [j] });

      const lockFile = generateLockFile([makeWorkflowWithSource(w)]);
      const lockJob = lockFile.workflows[0].jobs[0];
      if (lockJob._type === 'static') {
        expect(lockJob.steps[0].name).toBe('step-1');
        expect(lockJob.steps[1].name).toBe('step-2');
      }
    });

    it('handles mixed named/unnamed steps correctly (counter only increments for unnamed)', () => {
      const named1 = step('build', async () => {});
      const bareFn = async () => {};
      const named2 = step('deploy', async () => {});
      const j = job('ci', { runsOn: 'linux', steps: [named1, bareFn, named2] });
      const w = workflow('ci', { jobs: [j] });

      const lockFile = generateLockFile([makeWorkflowWithSource(w)]);
      const lockJob = lockFile.workflows[0].jobs[0];
      if (lockJob._type === 'static') {
        expect(lockJob.steps[0].name).toBe('build');
        expect(lockJob.steps[1].name).toBe('step-1');
        expect(lockJob.steps[2].name).toBe('deploy');
      }
    });

    it('resets step counter per job (counter scoped to job)', () => {
      const bareFn = async () => {};
      const j1 = job('job1', { runsOn: 'linux', steps: [bareFn, bareFn] });
      const j2 = job('job2', { runsOn: 'linux', steps: [bareFn] });
      const w = workflow('ci', { jobs: [j1, j2] });

      const lockFile = generateLockFile([makeWorkflowWithSource(w)]);
      const lockJob1 = lockFile.workflows[0].jobs[0];
      const lockJob2 = lockFile.workflows[0].jobs[1];
      if (lockJob1._type === 'static' && lockJob2._type === 'static') {
        expect(lockJob1.steps[0].name).toBe('step-1');
        expect(lockJob1.steps[1].name).toBe('step-2');
        expect(lockJob2.steps[0].name).toBe('step-1');
      }
    });
  });

  describe('job auto-IDs', () => {
    it('assigns job-N names to UUID-named jobs', () => {
      const j1 = job({ runsOn: 'linux', steps: [step('build', async () => {})] });
      const j2 = job({ runsOn: 'linux', steps: [step('test', async () => {})] });
      const w = workflow('ci', { jobs: [j1, j2] });

      const lockFile = generateLockFile([makeWorkflowWithSource(w)]);
      const lockJob1 = lockFile.workflows[0].jobs[0];
      const lockJob2 = lockFile.workflows[0].jobs[1];
      if (lockJob1._type === 'static' && lockJob2._type === 'static') {
        expect(lockJob1.name).toBe('job-1');
        expect(lockJob2.name).toBe('job-2');
      }
    });

    it('resolves needs references to renamed job-N names for UUID-named jobs', () => {
      const build = job({ runsOn: 'linux', steps: [step('build', async () => {})] });
      const test = job({ runsOn: 'linux', needs: [build], steps: [step('test', async () => {})] });
      const w = workflow('ci', { jobs: [build, test] });

      const lockFile = generateLockFile([makeWorkflowWithSource(w)]);
      const lockBuild = lockFile.workflows[0].jobs[0];
      const lockTest = lockFile.workflows[0].jobs[1];
      if (lockBuild._type === 'static' && lockTest._type === 'static') {
        expect(lockBuild.name).toBe('job-1');
        expect(lockTest.name).toBe('job-2');
        // needs must reference the renamed name, not the original UUID
        expect(lockTest.needs).toEqual(['job-1']);
      }
    });

    it('resolves needs with mixed named and UUID-named jobs', () => {
      const build = job('build', { runsOn: 'linux', steps: [step('s1', async () => {})] });
      const lint = job({ runsOn: 'linux', steps: [step('s2', async () => {})] });
      const test = job({
        runsOn: 'linux',
        needs: [build, lint],
        steps: [step('s3', async () => {})],
      });
      const w = workflow('ci', { jobs: [build, lint, test] });

      const lockFile = generateLockFile([makeWorkflowWithSource(w)]);
      const lockBuild = lockFile.workflows[0].jobs[0];
      const lockLint = lockFile.workflows[0].jobs[1];
      const lockTest = lockFile.workflows[0].jobs[2];
      if (
        lockBuild._type === 'static' &&
        lockLint._type === 'static' &&
        lockTest._type === 'static'
      ) {
        expect(lockBuild.name).toBe('build');
        expect(lockLint.name).toBe('job-1');
        expect(lockTest.name).toBe('job-2');
        // needs must resolve named job as-is and UUID job to its renamed name
        expect(lockTest.needs).toEqual(['build', 'job-1']);
      }
    });

    it('handles mixed named/unnamed jobs correctly (counter only increments for unnamed)', () => {
      const j1 = job('ci', { runsOn: 'linux', steps: [step('build', async () => {})] });
      const j2 = job({ runsOn: 'linux', steps: [step('test', async () => {})] });
      const j3 = job('deploy', { runsOn: 'linux', steps: [step('deploy', async () => {})] });
      const w = workflow('ci', { jobs: [j1, j2, j3] });

      const lockFile = generateLockFile([makeWorkflowWithSource(w)]);
      const lockJob1 = lockFile.workflows[0].jobs[0];
      const lockJob2 = lockFile.workflows[0].jobs[1];
      const lockJob3 = lockFile.workflows[0].jobs[2];
      if (
        lockJob1._type === 'static' &&
        lockJob2._type === 'static' &&
        lockJob3._type === 'static'
      ) {
        expect(lockJob1.name).toBe('ci');
        expect(lockJob2.name).toBe('job-1');
        expect(lockJob3.name).toBe('deploy');
      }
    });
  });

  describe('run shorthand', () => {
    it('produces a single step in lock file for run shorthand job', () => {
      const j = job('deploy', {
        runsOn: 'linux',
        run: async () => {
          return { url: 'https://example.com' };
        },
      });
      const w = workflow('ci', { jobs: [j] });

      const lockFile = generateLockFile([makeWorkflowWithSource(w)]);
      const lockJob = lockFile.workflows[0].jobs[0];
      if (lockJob._type === 'static') {
        expect(lockJob.steps).toHaveLength(1);
        // run shorthand creates a bare function, so it gets a counter name
        expect(lockJob.steps[0].name).toBe('step-1');
      }
    });
  });
});

describe('generator - environment/env/concurrencyGroup', () => {
  describe('environment extraction', () => {
    it('extracts static environment string', () => {
      const s = step('deploy', async () => {});
      const j = job('deploy', {
        runsOn: 'linux',
        steps: [s],
        environment: 'production',
      });
      const w = workflow('ci', { jobs: [j] });

      const lockFile = generateLockFile([makeWorkflowWithSource(w)]);
      const lockJob = lockFile.workflows[0].jobs[0];
      if (lockJob._type === 'static') {
        expect(lockJob.environment).toBe('production');
        expect(lockJob).not.toHaveProperty('dynamicEnvironment');
      }
    });

    it('sets dynamicEnvironment flag for impure (async) function environment', () => {
      const s = step('deploy', async () => {});
      const j = job('deploy', {
        runsOn: 'linux',
        steps: [s],
        environment: async () => 'staging',
      });
      const w = workflow('ci', { jobs: [j] });

      const lockFile = generateLockFile([makeWorkflowWithSource(w)]);
      const lockJob = lockFile.workflows[0].jobs[0];
      if (lockJob._type === 'static') {
        expect(lockJob.dynamicEnvironment).toBe(true);
        expect(lockJob).not.toHaveProperty('environment');
      }
    });

    it('inlines pure environment function as LockInlineValue', () => {
      const s = step('deploy', async () => {});
      const envFn = (event: { ref: string }) => event.ref.split('/').pop();
      const j = job('deploy', {
        runsOn: 'linux',
        steps: [s],
        environment: envFn as unknown as () => Promise<string>,
      });
      const w = workflow('ci', { jobs: [j] });

      const lockFile = generateLockFile([makeWorkflowWithSource(w)]);
      const lockJob = lockFile.workflows[0].jobs[0];
      if (lockJob._type === 'static') {
        expect(lockJob.dynamicEnvironment).toBe(true);
        expect(lockJob.environment).toEqual({
          _type: 'inline',
          expression: envFn.toString(),
        });
      }
    });

    it('warns on impure environment function', () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const s = step('deploy', async () => {});
      const j = job('deploy', {
        runsOn: 'linux',
        steps: [s],
        environment: async () => 'staging',
      });
      const w = workflow('ci', { jobs: [j] });

      generateLockFile([makeWorkflowWithSource(w)]);
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('init job will be required'));
      warnSpy.mockRestore();
    });

    it('omits environment fields when not set', () => {
      const s = step('build', async () => {});
      const j = job('build', { runsOn: 'linux', steps: [s] });
      const w = workflow('ci', { jobs: [j] });

      const lockFile = generateLockFile([makeWorkflowWithSource(w)]);
      const lockJob = lockFile.workflows[0].jobs[0];
      if (lockJob._type === 'static') {
        expect(lockJob).not.toHaveProperty('environment');
        expect(lockJob).not.toHaveProperty('dynamicEnvironment');
      }
    });
  });

  describe('env extraction', () => {
    it('extracts static env object', () => {
      const s = step('build', async () => {});
      const j = job('build', {
        runsOn: 'linux',
        steps: [s],
        env: { NODE_ENV: 'production', CI: 'true' },
      });
      const w = workflow('ci', { jobs: [j] });

      const lockFile = generateLockFile([makeWorkflowWithSource(w)]);
      const lockJob = lockFile.workflows[0].jobs[0];
      if (lockJob._type === 'static') {
        expect(lockJob.env).toEqual({ NODE_ENV: 'production', CI: 'true' });
        expect(lockJob).not.toHaveProperty('dynamicEnv');
      }
    });

    it('sets dynamicEnv flag for impure (async) function env', () => {
      const s = step('build', async () => {});
      const j = job('build', {
        runsOn: 'linux',
        steps: [s],
        env: async () => ({ NODE_ENV: 'test' }),
      });
      const w = workflow('ci', { jobs: [j] });

      const lockFile = generateLockFile([makeWorkflowWithSource(w)]);
      const lockJob = lockFile.workflows[0].jobs[0];
      if (lockJob._type === 'static') {
        expect(lockJob.dynamicEnv).toBe(true);
        expect(lockJob).not.toHaveProperty('env');
      }
    });

    it('inlines pure env function as LockInlineValue', () => {
      const s = step('build', async () => {});
      const envFn = (event: { env: string }) => ({ NODE_ENV: event.env });
      const j = job('build', {
        runsOn: 'linux',
        steps: [s],
        env: envFn as unknown as () => Promise<Record<string, string>>,
      });
      const w = workflow('ci', { jobs: [j] });

      const lockFile = generateLockFile([makeWorkflowWithSource(w)]);
      const lockJob = lockFile.workflows[0].jobs[0];
      if (lockJob._type === 'static') {
        expect(lockJob.dynamicEnv).toBe(true);
        expect(lockJob.env).toEqual({
          _type: 'inline',
          expression: envFn.toString(),
        });
      }
    });

    it('omits env fields when not set', () => {
      const s = step('build', async () => {});
      const j = job('build', { runsOn: 'linux', steps: [s] });
      const w = workflow('ci', { jobs: [j] });

      const lockFile = generateLockFile([makeWorkflowWithSource(w)]);
      const lockJob = lockFile.workflows[0].jobs[0];
      if (lockJob._type === 'static') {
        expect(lockJob).not.toHaveProperty('env');
        expect(lockJob).not.toHaveProperty('dynamicEnv');
      }
    });
  });

  describe('concurrencyGroup extraction', () => {
    it('extracts static concurrencyGroup string', () => {
      const s = step('deploy', async () => {});
      const j = job('deploy', {
        runsOn: 'linux',
        steps: [s],
        concurrencyGroup: 'deploy-prod',
      });
      const w = workflow('ci', { jobs: [j] });

      const lockFile = generateLockFile([makeWorkflowWithSource(w)]);
      const lockJob = lockFile.workflows[0].jobs[0];
      if (lockJob._type === 'static') {
        expect(lockJob.concurrencyGroup).toBe('deploy-prod');
        expect(lockJob).not.toHaveProperty('dynamicConcurrencyGroup');
      }
    });

    it('sets dynamicConcurrencyGroup flag for function concurrencyGroup', () => {
      const s = step('deploy', async () => {});
      const j = job('deploy', {
        runsOn: 'linux',
        steps: [s],
        concurrencyGroup: async () => 'deploy-staging',
      });
      const w = workflow('ci', { jobs: [j] });

      const lockFile = generateLockFile([makeWorkflowWithSource(w)]);
      const lockJob = lockFile.workflows[0].jobs[0];
      if (lockJob._type === 'static') {
        expect(lockJob.dynamicConcurrencyGroup).toBe(true);
        expect(lockJob).not.toHaveProperty('concurrencyGroup');
      }
    });

    it('omits concurrencyGroup fields when not set', () => {
      const s = step('build', async () => {});
      const j = job('build', { runsOn: 'linux', steps: [s] });
      const w = workflow('ci', { jobs: [j] });

      const lockFile = generateLockFile([makeWorkflowWithSource(w)]);
      const lockJob = lockFile.workflows[0].jobs[0];
      if (lockJob._type === 'static') {
        expect(lockJob).not.toHaveProperty('concurrencyGroup');
        expect(lockJob).not.toHaveProperty('dynamicConcurrencyGroup');
      }
    });
  });

  describe('contexts removal', () => {
    it('does not include contexts in lock job output', () => {
      const s = step('build', async () => {});
      const j = job('build', { runsOn: 'linux', steps: [s] });
      const w = workflow('ci', { jobs: [j] });

      const lockFile = generateLockFile([makeWorkflowWithSource(w)]);
      const lockJob = lockFile.workflows[0].jobs[0];
      if (lockJob._type === 'static') {
        expect(lockJob).not.toHaveProperty('contexts');
        expect(lockJob).not.toHaveProperty('dynamicContexts');
      }
    });
  });

  describe('combined fields', () => {
    it('extracts all three fields together', () => {
      const s = step('deploy', async () => {});
      const j = job('deploy', {
        runsOn: 'linux',
        steps: [s],
        environment: 'production',
        env: { DEPLOY_TARGET: 'aws' },
        concurrencyGroup: 'deploy-prod',
      });
      const w = workflow('ci', { jobs: [j] });

      const lockFile = generateLockFile([makeWorkflowWithSource(w)]);
      const lockJob = lockFile.workflows[0].jobs[0];
      if (lockJob._type === 'static') {
        expect(lockJob.environment).toBe('production');
        expect(lockJob.env).toEqual({ DEPLOY_TARGET: 'aws' });
        expect(lockJob.concurrencyGroup).toBe('deploy-prod');
      }
    });
  });
});

describe('generator - hook flags', () => {
  describe('step-level hooks', () => {
    it('sets hasOnCancel for step with onCancel hook', () => {
      const s = step('deploy', {
        run: async () => {},
        onCancel: async () => {},
      });
      const j = job('build', { runsOn: 'linux', steps: [s] });
      const w = workflow('ci', { jobs: [j] });

      const lockFile = generateLockFile([makeWorkflowWithSource(w)]);
      const lockJob = lockFile.workflows[0].jobs[0];
      if (lockJob._type === 'static') {
        expect(lockJob.steps[0].hasOnCancel).toBe(true);
      }
    });

    it('sets hasCleanup for step with cleanup hook', () => {
      const s = step('deploy', {
        run: async () => {},
        cleanup: async () => {},
      });
      const j = job('build', { runsOn: 'linux', steps: [s] });
      const w = workflow('ci', { jobs: [j] });

      const lockFile = generateLockFile([makeWorkflowWithSource(w)]);
      const lockJob = lockFile.workflows[0].jobs[0];
      if (lockJob._type === 'static') {
        expect(lockJob.steps[0].hasCleanup).toBe(true);
      }
    });

    it('omits hook flags when hooks are not present', () => {
      const s = step('simple', async () => {});
      const j = job('build', { runsOn: 'linux', steps: [s] });
      const w = workflow('ci', { jobs: [j] });

      const lockFile = generateLockFile([makeWorkflowWithSource(w)]);
      const lockJob = lockFile.workflows[0].jobs[0];
      if (lockJob._type === 'static') {
        expect(lockJob.steps[0]).not.toHaveProperty('hasOnCancel');
        expect(lockJob.steps[0]).not.toHaveProperty('hasCleanup');
      }
    });
  });

  describe('step-level rules', () => {
    it('sets hasRules and rules for step with rules', () => {
      const s = step('deploy', {
        run: async () => {},
        rules: [rule('only main', () => true)],
      });
      const j = job('build', { runsOn: 'linux', steps: [s] });
      const w = workflow('ci', { jobs: [j] });

      const lockFile = generateLockFile([makeWorkflowWithSource(w)]);
      const lockJob = lockFile.workflows[0].jobs[0];
      if (lockJob._type === 'static') {
        expect(lockJob.steps[0].hasRules).toBe(true);
        expect(lockJob.steps[0].rules).toHaveLength(1);
        expect(lockJob.steps[0].rules![0]._type).toBe('dynamic');
        expect(lockJob.steps[0].rules![0].label).toBe('only main');
      }
    });

    it('omits rules when step has no rules', () => {
      const s = step('simple', async () => {});
      const j = job('build', { runsOn: 'linux', steps: [s] });
      const w = workflow('ci', { jobs: [j] });

      const lockFile = generateLockFile([makeWorkflowWithSource(w)]);
      const lockJob = lockFile.workflows[0].jobs[0];
      if (lockJob._type === 'static') {
        expect(lockJob.steps[0]).not.toHaveProperty('hasRules');
        expect(lockJob.steps[0]).not.toHaveProperty('rules');
      }
    });
  });

  describe('step-level check facet flags', () => {
    it('sets hasCheck and hasWhenInSync for a checked step', () => {
      const s = step('cfg', {
        drift: sdk.z.object({ want: sdk.z.string() }),
        check: async () => ({ want: 'x' }),
        summarize: (d) => `would write ${d.want}`,
        run: async (_ctx, drift) => {
          void drift;
        },
        whenInSync: async () => {},
      });
      const j = job('build', { runsOn: 'linux', steps: [s] });
      const w = workflow('ci', { jobs: [j] });

      const lockFile = generateLockFile([makeWorkflowWithSource(w)]);
      const lockJob = lockFile.workflows[0].jobs[0];
      if (lockJob._type === 'static') {
        expect(lockJob.steps[0].hasCheck).toBe(true);
        expect(lockJob.steps[0].hasWhenInSync).toBe(true);
      }
    });

    it('omits check flags for a plain step', () => {
      const s = step('simple', async () => {});
      const j = job('build', { runsOn: 'linux', steps: [s] });
      const w = workflow('ci', { jobs: [j] });

      const lockFile = generateLockFile([makeWorkflowWithSource(w)]);
      const lockJob = lockFile.workflows[0].jobs[0];
      if (lockJob._type === 'static') {
        expect(lockJob.steps[0]).not.toHaveProperty('hasCheck');
        expect(lockJob.steps[0]).not.toHaveProperty('hasWhenInSync');
      }
    });
  });

  describe('job-level hooks', () => {
    it('sets hasOnCancel for job with onCancel hook', () => {
      const s = step('build', async () => {});
      const j = job('deploy', {
        runsOn: 'linux',
        steps: [s],
        onCancel: async () => {},
      });
      const w = workflow('ci', { jobs: [j] });

      const lockFile = generateLockFile([makeWorkflowWithSource(w)]);
      const lockJob = lockFile.workflows[0].jobs[0];
      if (lockJob._type === 'static') {
        expect(lockJob.hasOnCancel).toBe(true);
      }
    });

    it('sets all 6 hook flags for job with all hooks', () => {
      const hookFn = async () => {};
      const s = step('build', async () => {});
      const j = job('deploy', {
        runsOn: 'linux',
        steps: [s],
        onCancel: hookFn,
        cleanup: hookFn,
        onSuccess: hookFn,
        onFailure: hookFn,
        beforeStep: hookFn,
        afterStep: hookFn,
      });
      const w = workflow('ci', { jobs: [j] });

      const lockFile = generateLockFile([makeWorkflowWithSource(w)]);
      const lockJob = lockFile.workflows[0].jobs[0];
      if (lockJob._type === 'static') {
        expect(lockJob.hasOnCancel).toBe(true);
        expect(lockJob.hasCleanup).toBe(true);
        expect(lockJob.hasOnSuccess).toBe(true);
        expect(lockJob.hasOnFailure).toBe(true);
        expect(lockJob.hasBeforeStep).toBe(true);
        expect(lockJob.hasAfterStep).toBe(true);
      }
    });

    it('sets gracePeriod on job', () => {
      const s = step('build', async () => {});
      const j = job('deploy', {
        runsOn: 'linux',
        steps: [s],
        gracePeriod: 60,
      });
      const w = workflow('ci', { jobs: [j] });

      const lockFile = generateLockFile([makeWorkflowWithSource(w)]);
      const lockJob = lockFile.workflows[0].jobs[0];
      if (lockJob._type === 'static') {
        expect(lockJob.gracePeriod).toBe(60);
      }
    });

    it('sets timeout on job', () => {
      const s = step('build', async () => {});
      const j = job('build', { runsOn: 'linux', steps: [s], timeout: 600_000 });
      const w = workflow('ci', { jobs: [j] });

      const lockFile = generateLockFile([makeWorkflowWithSource(w)]);
      const lockJob = lockFile.workflows[0].jobs[0];
      if (lockJob._type === 'static') {
        expect(lockJob.timeout).toBe(600_000);
      }
    });

    it('omits timeout when not set on job', () => {
      const s = step('build', async () => {});
      const j = job('build', { runsOn: 'linux', steps: [s] });
      const w = workflow('ci', { jobs: [j] });

      const lockFile = generateLockFile([makeWorkflowWithSource(w)]);
      expect(lockFile.workflows[0].jobs[0]).not.toHaveProperty('timeout');
    });

    it('omits hook flags when hooks are not present on job', () => {
      const s = step('build', async () => {});
      const j = job('build', { runsOn: 'linux', steps: [s] });
      const w = workflow('ci', { jobs: [j] });

      const lockFile = generateLockFile([makeWorkflowWithSource(w)]);
      const lockJob = lockFile.workflows[0].jobs[0];
      if (lockJob._type === 'static') {
        expect(lockJob).not.toHaveProperty('hasOnCancel');
        expect(lockJob).not.toHaveProperty('hasCleanup');
        expect(lockJob).not.toHaveProperty('hasOnSuccess');
        expect(lockJob).not.toHaveProperty('hasOnFailure');
        expect(lockJob).not.toHaveProperty('hasBeforeStep');
        expect(lockJob).not.toHaveProperty('hasAfterStep');
        expect(lockJob).not.toHaveProperty('gracePeriod');
        expect(lockJob).not.toHaveProperty('resources');
      }
    });

    it('emits resources requests-only on job', () => {
      const s = step('build', async () => {});
      const j = job('deploy', {
        runsOn: 'linux',
        steps: [s],
        resources: { requests: { cpus: 1, memory: '512m' } },
      });
      const w = workflow('ci', { jobs: [j] });

      const lockFile = generateLockFile([makeWorkflowWithSource(w)]);
      const lockJob = lockFile.workflows[0].jobs[0];
      if (lockJob._type === 'static') {
        expect(lockJob.resources).toEqual({ requests: { cpus: 1, memory: '512m' } });
      }
    });

    it('emits resources limits-only on job', () => {
      const s = step('build', async () => {});
      const j = job('deploy', {
        runsOn: 'linux',
        steps: [s],
        resources: { limits: { cpus: 2, memory: '2g' } },
      });
      const w = workflow('ci', { jobs: [j] });

      const lockFile = generateLockFile([makeWorkflowWithSource(w)]);
      const lockJob = lockFile.workflows[0].jobs[0];
      if (lockJob._type === 'static') {
        expect(lockJob.resources).toEqual({ limits: { cpus: 2, memory: '2g' } });
      }
    });

    it('emits resources with both requests and limits', () => {
      const s = step('build', async () => {});
      const j = job('deploy', {
        runsOn: 'linux',
        steps: [s],
        resources: {
          requests: { cpus: 1, memory: '1g' },
          limits: { cpus: 2, memory: '2g' },
        },
      });
      const w = workflow('ci', { jobs: [j] });

      const lockFile = generateLockFile([makeWorkflowWithSource(w)]);
      const lockJob = lockFile.workflows[0].jobs[0];
      if (lockJob._type === 'static') {
        expect(lockJob.resources).toEqual({
          requests: { cpus: 1, memory: '1g' },
          limits: { cpus: 2, memory: '2g' },
        });
      }
    });

    it('rejects invalid memory format at compile time', () => {
      const s = step('build', async () => {});
      const j = job('deploy', {
        runsOn: 'linux',
        steps: [s],
        resources: { requests: { memory: '512' } },
      });
      const w = workflow('ci', { jobs: [j] });

      expect(() => generateLockFile([makeWorkflowWithSource(w)])).toThrow(/invalid resources/);
    });

    it('rejects requests greater than limits at compile time', () => {
      const s = step('build', async () => {});
      const j = job('deploy', {
        runsOn: 'linux',
        steps: [s],
        resources: {
          requests: { cpus: 4, memory: '4g' },
          limits: { cpus: 2, memory: '2g' },
        },
      });
      const w = workflow('ci', { jobs: [j] });

      expect(() => generateLockFile([makeWorkflowWithSource(w)])).toThrow(/must not exceed/);
    });

    it('rejects cpus > 256', () => {
      const s = step('build', async () => {});
      const j = job('deploy', {
        runsOn: 'linux',
        steps: [s],
        resources: { requests: { cpus: 1000 } },
      });
      const w = workflow('ci', { jobs: [j] });

      expect(() => generateLockFile([makeWorkflowWithSource(w)])).toThrow(/invalid resources/);
    });
  });

  describe('workflow-level hooks and concurrency', () => {
    it('sets hook flags for workflow with hooks', () => {
      const hookFn = async () => {};
      const s = step('build', async () => {});
      const j = job('build', { runsOn: 'linux', steps: [s] });
      const w = workflow('ci', {
        jobs: [j],
        onCancel: hookFn,
        cleanup: hookFn,
        onSuccess: hookFn,
        onFailure: hookFn,
      });

      const lockFile = generateLockFile([makeWorkflowWithSource(w)]);
      const lockWorkflow = lockFile.workflows[0];
      expect(lockWorkflow.hasOnCancel).toBe(true);
      expect(lockWorkflow.hasCleanup).toBe(true);
      expect(lockWorkflow.hasOnSuccess).toBe(true);
      expect(lockWorkflow.hasOnFailure).toBe(true);
    });

    it('omits hook flags when workflow has no hooks', () => {
      const s = step('build', async () => {});
      const j = job('build', { runsOn: 'linux', steps: [s] });
      const w = workflow('ci', { jobs: [j] });

      const lockFile = generateLockFile([makeWorkflowWithSource(w)]);
      const lockWorkflow = lockFile.workflows[0];
      expect(lockWorkflow).not.toHaveProperty('hasOnCancel');
      expect(lockWorkflow).not.toHaveProperty('hasCleanup');
      expect(lockWorkflow).not.toHaveProperty('hasOnSuccess');
      expect(lockWorkflow).not.toHaveProperty('hasOnFailure');
    });

    it('produces concurrency config for workflow with concurrency', () => {
      const s = step('build', async () => {});
      const j = job('build', { runsOn: 'linux', steps: [s] });
      const w = workflow('ci', {
        jobs: [j],
        concurrency: {
          group: () => 'main',
          cancelInProgress: true,
        },
      });

      const lockFile = generateLockFile([makeWorkflowWithSource(w)]);
      const lockWorkflow = lockFile.workflows[0];
      expect(lockWorkflow.concurrency).toBeDefined();
      expect(lockWorkflow.concurrency!.hasGroup).toBe(true);
      expect(lockWorkflow.concurrency!.cancelInProgress).toBe(true);
    });

    it('produces concurrency config with max', () => {
      const s = step('build', async () => {});
      const j = job('build', { runsOn: 'linux', steps: [s] });
      const w = workflow('ci', {
        jobs: [j],
        concurrency: {
          group: () => 'deploy',
          max: 3,
        },
      });

      const lockFile = generateLockFile([makeWorkflowWithSource(w)]);
      const lockWorkflow = lockFile.workflows[0];
      expect(lockWorkflow.concurrency).toBeDefined();
      expect(lockWorkflow.concurrency!.hasGroup).toBe(true);
      expect(lockWorkflow.concurrency!.max).toBe(3);
      expect(lockWorkflow.concurrency).not.toHaveProperty('cancelInProgress');
    });

    it('omits concurrency when not set', () => {
      const s = step('build', async () => {});
      const j = job('build', { runsOn: 'linux', steps: [s] });
      const w = workflow('ci', { jobs: [j] });

      const lockFile = generateLockFile([makeWorkflowWithSource(w)]);
      const lockWorkflow = lockFile.workflows[0];
      expect(lockWorkflow).not.toHaveProperty('concurrency');
    });
  });
});

describe('generator - runsOn normalization and validation', () => {
  describe('lock file normalization', () => {
    it('passes through string runsOn as-is', () => {
      const s = step('build', async () => {});
      const j = job('build', { runsOn: 'linux', steps: [s] });
      const w = workflow('ci', { jobs: [j] });

      const lockFile = generateLockFile([makeWorkflowWithSource(w)]);
      const lockJob = lockFile.workflows[0].jobs[0];
      if (lockJob._type === 'static') {
        expect(lockJob.runsOn).toEqual([{ kind: 'exact', value: 'linux' }]);
        expect(lockJob).not.toHaveProperty('excludeLabels');
      }
    });

    it('passes through array runsOn as-is', () => {
      const s = step('build', async () => {});
      const j = job('build', { runsOn: ['linux', 'docker'], steps: [s] });
      const w = workflow('ci', { jobs: [j] });

      const lockFile = generateLockFile([makeWorkflowWithSource(w)]);
      const lockJob = lockFile.workflows[0].jobs[0];
      if (lockJob._type === 'static') {
        expect(lockJob.runsOn).toEqual([
          { kind: 'exact', value: 'linux' },
          { kind: 'exact', value: 'docker' },
        ]);
        expect(lockJob).not.toHaveProperty('excludeLabels');
      }
    });

    it('normalizes object runsOn with single label to matchers', () => {
      const s = step('build', async () => {});
      const j = job('build', { runsOn: { labels: 'linux', exclude: 'gpu' }, steps: [s] });
      const w = workflow('ci', { jobs: [j] });

      const lockFile = generateLockFile([makeWorkflowWithSource(w)]);
      const lockJob = lockFile.workflows[0].jobs[0];
      if (lockJob._type === 'static') {
        expect(lockJob.runsOn).toEqual([{ kind: 'exact', value: 'linux' }]);
        expect(lockJob.excludeLabels).toEqual([{ kind: 'exact', value: 'gpu' }]);
      }
    });

    it('normalizes object runsOn with array labels and array exclude', () => {
      const s = step('build', async () => {});
      const j = job('build', {
        runsOn: { labels: ['linux', 'docker'], exclude: ['gpu'] },
        steps: [s],
      });
      const w = workflow('ci', { jobs: [j] });

      const lockFile = generateLockFile([makeWorkflowWithSource(w)]);
      const lockJob = lockFile.workflows[0].jobs[0];
      if (lockJob._type === 'static') {
        expect(lockJob.runsOn).toEqual([
          { kind: 'exact', value: 'linux' },
          { kind: 'exact', value: 'docker' },
        ]);
        expect(lockJob.excludeLabels).toEqual([{ kind: 'exact', value: 'gpu' }]);
      }
    });

    it('omits excludeLabels when object runsOn has no exclude', () => {
      const s = step('build', async () => {});
      const j = job('build', { runsOn: { labels: 'linux' }, steps: [s] });
      const w = workflow('ci', { jobs: [j] });

      const lockFile = generateLockFile([makeWorkflowWithSource(w)]);
      const lockJob = lockFile.workflows[0].jobs[0];
      if (lockJob._type === 'static') {
        expect(lockJob.runsOn).toEqual([{ kind: 'exact', value: 'linux' }]);
        expect(lockJob).not.toHaveProperty('excludeLabels');
      }
    });
  });

  describe('runsOnAll host fan-out', () => {
    it('lowers runsOnAll to LockJob.runsOnAll and omits runsOn', () => {
      const j = job('patch', {
        runsOnAll: ['role:web', '!kici:host:web-01'],
        steps: [step('s', async () => {})],
      });
      const w = workflow('ci', { jobs: [j] });
      const lockFile = generateLockFile([makeWorkflowWithSource(w)]);
      const lockJob = lockFile.workflows[0].jobs[0];
      if (lockJob._type === 'static') {
        expect(lockJob.runsOnAll).toEqual({
          include: [[{ kind: 'exact', value: 'role:web' }]],
          exclude: [{ kind: 'exact', value: 'kici:host:web-01' }],
        });
        expect(lockJob).not.toHaveProperty('runsOn');
      }
    });

    it('lowers onUnreachable alongside runsOnAll', () => {
      const j = job('patch', {
        runsOnAll: 'role:web',
        onUnreachable: 'fail',
        steps: [step('s', async () => {})],
      });
      const w = workflow('ci', { jobs: [j] });
      const lockFile = generateLockFile([makeWorkflowWithSource(w)]);
      const lockJob = lockFile.workflows[0].jobs[0];
      if (lockJob._type === 'static') {
        expect(lockJob.onUnreachable).toBe('fail');
      }
    });

    it('rejects a job that sets both runsOn and runsOnAll', () => {
      // job() factory enforces mutual exclusion before the generator runs.
      expect(() => job('bad', { runsOn: 'linux', runsOnAll: 'role:web', steps: [] })).toThrow(
        /runsOn and runsOnAll are mutually exclusive/i,
      );
    });

    it('lowers maxParallel and failFast onto the LockJob', () => {
      const j = job('patch', {
        runsOnAll: 'role:web',
        maxParallel: 2,
        failFast: true,
        steps: [step('s', async () => {})],
      });
      const w = workflow('ci', { jobs: [j] });
      const lockFile = generateLockFile([makeWorkflowWithSource(w)]);
      const lockJob = lockFile.workflows[0].jobs[0];
      if (lockJob._type === 'static') {
        expect(lockJob.maxParallel).toBe(2);
        expect(lockJob.failFast).toBe(true);
      }
    });

    it('lowers maxParallel onto a matrix fan-out (fan-out-generic)', () => {
      const j = job('build', {
        runsOn: 'linux',
        matrix: { os: ['a', 'b', 'c'] },
        maxParallel: 1,
        steps: [step('s', async () => {})],
      });
      const w = workflow('ci', { jobs: [j] });
      const lockFile = generateLockFile([makeWorkflowWithSource(w)]);
      const lockJob = lockFile.workflows[0].jobs[0];
      if (lockJob._type === 'static') {
        expect(lockJob.maxParallel).toBe(1);
      }
    });

    it('rejects maxParallel < 1', () => {
      const j = job('bad', {
        runsOnAll: 'role:web',
        maxParallel: 0,
        steps: [step('s', async () => {})],
      });
      const w = workflow('ci', { jobs: [j] });
      expect(() => generateLockFile([makeWorkflowWithSource(w)])).toThrow(
        /maxParallel must be >= 1/i,
      );
    });

    it('omits maxParallel/failFast when unset', () => {
      const j = job('patch', { runsOnAll: 'role:web', steps: [step('s', async () => {})] });
      const w = workflow('ci', { jobs: [j] });
      const lockFile = generateLockFile([makeWorkflowWithSource(w)]);
      const lockJob = lockFile.workflows[0].jobs[0];
      if (lockJob._type === 'static') {
        expect(lockJob).not.toHaveProperty('maxParallel');
        expect(lockJob).not.toHaveProperty('failFast');
      }
    });
  });

  describe('overlap validation', () => {
    it('throws on overlapping labels and exclude', () => {
      const s = step('build', async () => {});
      const j = job('build', {
        runsOn: { labels: ['linux'], exclude: ['linux'] },
        steps: [s],
      });
      const w = workflow('ci', { jobs: [j] });

      expect(() => generateLockFile([makeWorkflowWithSource(w)])).toThrow(
        'labels and exclude overlap',
      );
    });

    it('throws on single overlapping label (string exclude)', () => {
      const s = step('build', async () => {});
      const j = job('build', {
        runsOn: { labels: 'gpu', exclude: ['gpu', 'arm64'] },
        steps: [s],
      });
      const w = workflow('ci', { jobs: [j] });

      expect(() => generateLockFile([makeWorkflowWithSource(w)])).toThrow(
        'labels and exclude overlap on [gpu]',
      );
    });

    it('does not throw for non-overlapping labels and exclude', () => {
      const s = step('build', async () => {});
      const j = job('build', {
        runsOn: { labels: ['linux'], exclude: ['gpu'] },
        steps: [s],
      });
      const w = workflow('ci', { jobs: [j] });

      expect(() => generateLockFile([makeWorkflowWithSource(w)])).not.toThrow();
    });

    it('does not throw for string runsOn (no validation needed)', () => {
      const s = step('build', async () => {});
      const j = job('build', { runsOn: 'linux', steps: [s] });
      const w = workflow('ci', { jobs: [j] });

      expect(() => generateLockFile([makeWorkflowWithSource(w)])).not.toThrow();
    });

    it('does not throw for array runsOn (no validation needed)', () => {
      const s = step('build', async () => {});
      const j = job('build', { runsOn: ['linux', 'docker'], steps: [s] });
      const w = workflow('ci', { jobs: [j] });

      expect(() => generateLockFile([makeWorkflowWithSource(w)])).not.toThrow();
    });
  });
});

describe('repos serialization (unified, no notRepos)', () => {
  it('push trigger with repos including !-prefixed exclusion generates lock trigger', () => {
    const pushTrigger = push({
      branches: ['main'],
      repos: ['myorg/*', '!myorg/secret-*'],
    });

    const result = transformTriggers([pushTrigger]);
    const lockPush = result.find((t) => t._type === 'push');
    expect(lockPush).toBeDefined();
    expect((lockPush as any).repos).toEqual([
      { type: 'glob', pattern: 'myorg/*' },
      { type: 'glob', pattern: '!myorg/secret-*' },
    ]);
  });

  it('push trigger without repos generates lock trigger WITHOUT repos field', () => {
    const pushTrigger = push({ branches: ['main'] });
    const result = transformTriggers([pushTrigger]);
    const lockPush = result.find((t) => t._type === 'push');
    expect(lockPush).toBeDefined();
    expect('repos' in lockPush!).toBe(false);
  });

  it('push trigger with empty repos array omits repos field', () => {
    const pushTrigger = push({ branches: ['main'] });
    const triggerWithEmptyRepos = {
      ...pushTrigger,
      repos: [],
    };
    const result = transformTriggers([triggerWithEmptyRepos]);
    const lockPush = result.find((t) => t._type === 'push');
    expect(lockPush).toBeDefined();
    expect('repos' in lockPush!).toBe(false);
  });

  it('PR trigger with repos serializes correctly', () => {
    const prTrigger = pr({ events: ['opened'], repos: ['myorg/*'] });
    const result = transformTriggers([prTrigger]);
    const lockPr = result.find((t) => t._type === 'pr');
    expect(lockPr).toBeDefined();
    expect((lockPr as any).repos).toEqual([{ type: 'glob', pattern: 'myorg/*' }]);
  });

  it('push trigger with mixed glob + regex repos serializes correctly', () => {
    const pushTrigger = push({
      branches: ['main'],
      repos: ['myorg/*', /^otherorg\/api-v\d+$/i],
    });
    const result = transformTriggers([pushTrigger]);
    const lockPush = result.find((t) => t._type === 'push');
    expect((lockPush as any).repos).toEqual([
      { type: 'glob', pattern: 'myorg/*' },
      { type: 'regex', pattern: '^otherorg\\/api-v\\d+$', flags: 'i' },
    ]);
  });
});

describe('generator - runsOn kici: selectors', () => {
  it('accepts a kici:os: platform-fact label in runsOn', () => {
    const j = job('build', { runsOn: 'kici:os:linux', run: async () => {} });
    const w = workflow('ci', { jobs: [j] });
    const lockFile = generateLockFile([makeWorkflowWithSource(w)]);
    const lockJob = lockFile.workflows[0].jobs[0];
    expect(lockJob._type).toBe('static');
    if (lockJob._type === 'static') {
      expect(lockJob.runsOn).toEqual([{ kind: 'exact', value: 'kici:os:linux' }]);
    }
  });

  it('accepts an array of kici: labels in runsOn', () => {
    const j = job('build', {
      runsOn: ['kici:os:linux', 'kici:arch:arm64'],
      run: async () => {},
    });
    const w = workflow('ci', { jobs: [j] });
    const lockFile = generateLockFile([makeWorkflowWithSource(w)]);
    const lockJob = lockFile.workflows[0].jobs[0];
    expect(lockJob._type).toBe('static');
    if (lockJob._type === 'static') {
      expect(lockJob.runsOn).toEqual([
        { kind: 'exact', value: 'kici:os:linux' },
        { kind: 'exact', value: 'kici:arch:arm64' },
      ]);
    }
  });

  it('accepts a scaler-assigned kici: label in runsOn (targeting is not granting)', () => {
    const j = job('build', { runsOn: 'kici:role:builder', run: async () => {} });
    const w = workflow('ci', { jobs: [j] });
    expect(() => generateLockFile([makeWorkflowWithSource(w)])).not.toThrow();
  });

  it('still rejects labels/exclude overlap in selector form', () => {
    const j = job('build', {
      runsOn: { labels: ['kici:os:linux'], exclude: ['kici:os:linux'] },
      run: async () => {},
    });
    const w = workflow('ci', { jobs: [j] });
    expect(() => generateLockFile([makeWorkflowWithSource(w)])).toThrow(/overlap/);
  });
});

describe('generator - result-aware dynamicJob', () => {
  it('serializes a result-aware dynamicJob with needs + resultAware', () => {
    const discover = job('discover', { runsOn: 'linux', run: async () => ({ targets: ['x'] }) });
    const reports = sdk.dynamicJob('reports', {
      needs: ['discover', sdk.dynamicGroup('scan')],
      generate: async () => [],
    });
    const w = workflow('ci', { jobs: [discover, reports] });
    const lockFile = generateLockFile([makeWorkflowWithSource(w)]);
    const entry = lockFile.workflows[0].jobs.find((j) => j._type === 'dynamic');
    expect(entry).toBeDefined();
    if (entry?._type !== 'dynamic') throw new Error('expected dynamic entry');
    expect(entry.resultAware).toBe(true);
    expect(entry.group).toBe('reports');
    // Bare string need stays a bare string; dynamicGroup normalizes to { group, ifFailed }.
    expect(entry.needs).toEqual(['discover', { group: 'scan', ifFailed: 'skip' }]);
  });

  it('event-only dynamicJob has no needs and no resultAware flag', () => {
    const shards = sdk.dynamicJob('shards', async () => []);
    const w = workflow('ci', { jobs: [shards] });
    const lockFile = generateLockFile([makeWorkflowWithSource(w)]);
    const entry = lockFile.workflows[0].jobs.find((j) => j._type === 'dynamic');
    if (entry?._type !== 'dynamic') throw new Error('expected dynamic entry');
    expect(entry.group).toBe('shards');
    expect(entry.needs).toBeUndefined();
    expect(entry.resultAware).toBeUndefined();
  });
});

describe('runsOn glob/regex compilation', () => {
  it('compiles a glob runsOn to a regex LabelMatcher', () => {
    const j = job('build', { runsOn: 'kici:host:box-*', run: async () => {} });
    const w = workflow('w', { triggers: [push()], jobs: [j] });
    const lock = generateLockFile([makeWorkflowWithSource(w)]);
    const lockJob = lock.workflows[0].jobs[0];
    if (lockJob._type === 'static') {
      expect(lockJob.runsOn?.[0].kind).toBe('regex');
    } else {
      throw new Error('expected static job');
    }
  });

  it('rejects a ReDoS-prone runsOn regex at compile time', () => {
    const j = job('build', { runsOn: /(a+)+$/, run: async () => {} });
    const w = workflow('w', { triggers: [push()], jobs: [j] });
    expect(() => generateLockFile([makeWorkflowWithSource(w)])).toThrow(/ReDoS-prone/);
  });

  it('keeps a plain string runsOn as an exact matcher', () => {
    const j = job('build', { runsOn: 'kici:os:linux', run: async () => {} });
    const w = workflow('w', { triggers: [push()], jobs: [j] });
    const lock = generateLockFile([makeWorkflowWithSource(w)]);
    const lockJob = lock.workflows[0].jobs[0];
    if (lockJob._type === 'static') {
      expect(lockJob.runsOn?.[0]).toEqual({ kind: 'exact', value: 'kici:os:linux' });
    } else {
      throw new Error('expected static job');
    }
  });
});

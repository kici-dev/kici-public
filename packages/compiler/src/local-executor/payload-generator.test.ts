import { describe, it, expect, vi, beforeEach } from 'vitest';
import { generateEventPayload } from './payload-generator.js';
import type { RunLocalOptions } from './types.js';

// Mock child_process.execSync for git commands
vi.mock('node:child_process', () => ({
  execSync: vi.fn(),
}));

// Mock buildEventPayload for --payload delegation
vi.mock('../test-runner/payload-builder.js', () => ({
  buildEventPayload: vi.fn(),
}));

import { execSync } from 'node:child_process';
import { buildEventPayload } from '../test-runner/payload-builder.js';

const mockExecSync = vi.mocked(execSync);
const mockBuildEventPayload = vi.mocked(buildEventPayload);

function makeOptions(overrides: Partial<RunLocalOptions> = {}): RunLocalOptions {
  return { event: 'push', ...overrides };
}

beforeEach(() => {
  vi.resetAllMocks();

  // Default: simulate a git repo
  mockExecSync.mockImplementation((cmd) => {
    const cmdStr = String(cmd);
    if (cmdStr.includes('rev-parse --abbrev-ref HEAD')) return 'feature/my-branch\n';
    if (cmdStr.includes('rev-parse HEAD')) return 'abc1234def5678\n';
    if (cmdStr.includes('diff --name-only HEAD')) return 'src/index.ts\nREADME.md\n';
    if (cmdStr.includes('diff --name-only --cached')) return 'src/utils.ts\n';
    return '';
  });
});

describe('generateEventPayload', () => {
  it('uses current git branch and HEAD SHA for push events', async () => {
    const result = await generateEventPayload('push', makeOptions());

    expect(result.type).toBe('push');
    expect(result.targetBranch).toBe('feature/my-branch');
    expect(result.payload.ref).toBe('refs/heads/feature/my-branch');
    expect(result.payload.after).toBe('abc1234def5678');
  });

  it('uses current branch as source and main as target for pr:open', async () => {
    const result = await generateEventPayload('pr:open', makeOptions({ event: 'pr:open' }));

    expect(result.type).toBe('pull_request');
    expect(result.action).toBe('opened');
    expect(result.sourceBranch).toBe('feature/my-branch');
    expect(result.targetBranch).toBe('main');
  });

  it('overrides detected branch with --branch flag', async () => {
    const result = await generateEventPayload('push', makeOptions({ branch: 'custom-branch' }));

    expect(result.targetBranch).toBe('custom-branch');
    expect(result.payload.ref).toBe('refs/heads/custom-branch');
  });

  it('overrides detected SHA with --sha flag', async () => {
    const result = await generateEventPayload('push', makeOptions({ sha: 'deadbeef12345678' }));

    expect(result.payload.after).toBe('deadbeef12345678');
  });

  it('delegates to buildEventPayload when --payload flag is provided', async () => {
    mockBuildEventPayload.mockResolvedValue({
      type: 'push',
      payload: { custom: true },
      targetBranch: 'from-file',
      changedFiles: [],
    });

    const result = await generateEventPayload(
      'push',
      makeOptions({ payload: '/path/to/event.json' }),
    );

    expect(mockBuildEventPayload).toHaveBeenCalledWith(
      'push',
      expect.objectContaining({
        payload: '/path/to/event.json',
      }),
    );
    expect(result.payload.custom).toBe(true);
  });

  it('detects changed files from git diff', async () => {
    const result = await generateEventPayload('push', makeOptions());

    // Should include both unstaged and cached changes, deduplicated
    expect(result.changedFiles).toContain('src/index.ts');
    expect(result.changedFiles).toContain('README.md');
    expect(result.changedFiles).toContain('src/utils.ts');
  });

  it('falls back gracefully when not in a git repo', async () => {
    mockExecSync.mockImplementation(() => {
      throw new Error('fatal: not a git repository');
    });

    const result = await generateEventPayload('push', makeOptions());

    expect(result.targetBranch).toBe('main');
    expect(result.payload.after).toBe('0000000000000000000000000000000000000000');
    expect(result.changedFiles).toEqual([]);
  });

  it('handles PR event with --branch as target branch', async () => {
    const result = await generateEventPayload(
      'pr:open',
      makeOptions({ event: 'pr:open', branch: 'develop' }),
    );

    expect(result.targetBranch).toBe('develop');
    expect(result.sourceBranch).toBe('feature/my-branch');
  });
});

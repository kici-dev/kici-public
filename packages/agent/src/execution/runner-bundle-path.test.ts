import { describe, it, expect } from 'vitest';
import { resolveRunnerBundlePath } from './job-runner.js';

// The container sandbox must run the self-contained bundle, not the external
// workflow-runner.js (which cannot load without the pnpm workspace). The bundle
// is a flat sibling of the resolved runner path, produced by build-service.mjs.
describe('resolveRunnerBundlePath', () => {
  it('derives the bundle sibling of the bundle-mode runner path', () => {
    expect(resolveRunnerBundlePath('/app/packages/agent/dist/workflow-runner.js')).toBe(
      '/app/packages/agent/dist/workflow-runner-bundle.js',
    );
  });

  it('keeps the bundle in the same directory as any runner path', () => {
    expect(resolveRunnerBundlePath('/x/y/execution/sandbox/workflow-runner.js')).toBe(
      '/x/y/execution/sandbox/workflow-runner-bundle.js',
    );
  });
});

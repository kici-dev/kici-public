import { describe, it, expect, vi, beforeEach } from 'vitest';
import { previewCommand, previewEvent } from './preview.js';

// Mock dependencies
vi.mock('../remote/config.js', () => ({
  loadGlobalConfig: vi.fn(),
}));

vi.mock('../execution/index.js', () => ({
  resolveKiciDir: vi.fn().mockReturnValue('/mock/.kici'),
  discoverWorkflows: vi.fn().mockResolvedValue({ workflows: [] }),
}));

vi.mock('../test-runner/payload-builder.js', () => ({
  buildEventPayload: vi.fn().mockResolvedValue({
    type: 'push',
    targetBranch: 'main',
    payload: {},
  }),
}));

vi.mock('../test-runner/dry-run.js', () => ({
  displayDryRun: vi.fn(),
}));

vi.mock('../test-runner/secrets-file.js', () => ({
  loadSecretsFile: vi.fn().mockResolvedValue({ flat: {}, contexts: {} }),
}));

vi.mock('@kici-dev/engine', () => ({
  matchAllWorkflows: vi.fn().mockReturnValue([]),
}));

vi.mock('../lockfile/generator.js', () => ({
  transformTriggers: vi.fn().mockReturnValue([]),
}));

// Suppress logger output in tests
vi.mock('@kici-dev/core', () => ({
  logger: {
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
  },

  toErrorMessage: (err) => (err instanceof Error ? err.message : String(err)),
}));

// Mock node:fs/promises
vi.mock('node:fs/promises', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...original,
    writeFile: vi.fn().mockResolvedValue(undefined),
  };
});

describe('kici preview command (dry-run only)', () => {
  let loggerInfo: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.clearAllMocks();
    const { logger } = await import('@kici-dev/core');
    loggerInfo = logger.info as ReturnType<typeof vi.fn>;
  });

  describe('no args (usage help)', () => {
    it('shows usage instructions when no event provided', async () => {
      const result = await previewCommand(undefined, { kiciDir: '.kici' });

      expect(result).toBe(true);
      // Should show usage text
      expect(loggerInfo).toHaveBeenCalled();
    });
  });

  describe('event arg (dry-run)', () => {
    it('runs dry-run for push event', async () => {
      const result = await previewCommand('push', { kiciDir: '.kici' });

      // Dry-run path should not throw
      // The underlying previewEvent uses displayDryRun (mocked)
      expect(typeof result).toBe('boolean');
    });

    it('runs dry-run for pr:open event', async () => {
      await previewCommand('pr:open', { kiciDir: '.kici' });
      // Should not throw
    });

    it('runs dry-run for schedule event', async () => {
      await previewCommand('schedule', { kiciDir: '.kici' });
    });

    it('runs dry-run for lifecycle:workflow_complete event', async () => {
      await previewCommand('lifecycle:workflow_complete', { kiciDir: '.kici' });
    });

    it('runs dry-run for webhook:stripe event', async () => {
      await previewCommand('webhook:stripe', { kiciDir: '.kici' });
    });
  });

  describe('fixture-like arg (migration message)', () => {
    it('prints migration message when fixture name is given', async () => {
      const result = await previewCommand('push-main', { kiciDir: '.kici' });

      expect(result).toBe(false);
      // Should print migration message mentioning kici run remote
      expect(loggerInfo).toHaveBeenCalledWith(expect.stringContaining('kici run remote push-main'));
    });

    it('prints migration message for multi-word fixture names', async () => {
      const result = await previewCommand('my-custom-fixture', { kiciDir: '.kici' });

      expect(result).toBe(false);
      expect(loggerInfo).toHaveBeenCalledWith(
        expect.stringContaining('kici run remote my-custom-fixture'),
      );
    });

    it('does not trigger migration for colon-separated patterns', async () => {
      // Colon patterns are treated as potential event types, not fixture names
      // Even unknown ones should try the dry-run path (will error naturally)
      const result = await previewCommand('unknown:event', { kiciDir: '.kici' });
      // This should try to parse as an event -- whether it succeeds depends on parseEventArg
      expect(typeof result).toBe('boolean');
    });
  });

  describe('--dry-run backward compatibility', () => {
    it('still accepts --dry-run flag', async () => {
      const result = await previewCommand(undefined, { dryRun: 'push', kiciDir: '.kici' });

      // Should delegate to previewEvent
      expect(typeof result).toBe('boolean');
    });
  });

  describe('previewEvent', () => {
    it('accepts push event type', async () => {
      const result = await previewEvent('push', { kiciDir: '.kici' });
      expect(typeof result).toBe('boolean');
    });

    it('accepts lifecycle:workflow_complete event type', async () => {
      const result = await previewEvent('lifecycle:workflow_complete', { kiciDir: '.kici' });
      expect(typeof result).toBe('boolean');
    });

    it('accepts schedule event type', async () => {
      const result = await previewEvent('schedule', { kiciDir: '.kici' });
      expect(typeof result).toBe('boolean');
    });

    it('accepts webhook:stripe event type', async () => {
      const result = await previewEvent('webhook:stripe', { kiciDir: '.kici' });
      expect(typeof result).toBe('boolean');
    });

    it('passes an impure dynamic value as a purity warning to displayDryRun', async () => {
      const { discoverWorkflows } = await import('../execution/index.js');
      const { matchAllWorkflows } = await import('@kici-dev/engine');
      const { displayDryRun } = await import('../test-runner/dry-run.js');

      const workflow = {
        name: 'ci',
        on: [],
        triggers: [],
        jobs: [
          {
            name: 'build',
            runsOn: 'kici:os:linux',
            context: async (event: { targetBranch: string }) => event.targetBranch,
            steps: [],
          },
        ],
      };
      vi.mocked(discoverWorkflows).mockResolvedValueOnce({
        workflows: [{ workflow }],
      } as never);
      vi.mocked(matchAllWorkflows).mockReturnValueOnce([
        { workflowName: 'ci', matched: true, matchedTrigger: 0, checks: [], summary: 'matched' },
      ] as never);

      await previewEvent('push', { kiciDir: '.kici' });

      const call = vi.mocked(displayDryRun).mock.calls.at(-1)!;
      const purityWarnings = call[3] as Array<{ jobName: string; field: string; reason: string }>;
      expect(purityWarnings).toHaveLength(1);
      expect(purityWarnings[0]).toMatchObject({ jobName: 'build', field: 'context' });
      expect(purityWarnings[0].reason).toContain('async');
    });
  });
});

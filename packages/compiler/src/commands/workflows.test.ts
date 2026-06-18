import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

// Mock os.homedir to isolate tests from real home directory
vi.mock('node:os', async () => {
  const actual = await vi.importActual<typeof import('node:os')>('node:os');
  return {
    ...actual,
    default: {
      ...actual,
      homedir: vi.fn(),
    },
  };
});

// Mock global fetch
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

import { workflowsListCommand } from './workflows.js';

describe('kici workflows list', () => {
  let tempDir: string;
  let consoleLogSpy: ReturnType<typeof vi.spyOn>;
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kici-workflows-test-'));
    vi.mocked(os.homedir).mockReturnValue(tempDir);
    consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    mockFetch.mockReset();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  async function writeConfig(config: Record<string, unknown>): Promise<void> {
    const configDir = path.join(tempDir, '.kici');
    await fs.mkdir(configDir, { recursive: true });
    await fs.writeFile(path.join(configDir, 'config'), JSON.stringify(config), { mode: 0o600 });
  }

  const sampleRegistrations = [
    {
      id: 'reg-1',
      repoIdentifier: 'org/infra',
      workflowName: 'deploy-on-event',
      triggerTypes: ['kici_event'],
      triggers: [],
      lastTriggeredAt: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
      nextFireAt: null,
      sourceRepos: [],
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
    },
    {
      id: 'reg-2',
      repoIdentifier: 'org/api',
      workflowName: 'nightly-cleanup',
      triggerTypes: ['schedule'],
      triggers: [],
      lastTriggeredAt: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString(),
      nextFireAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
      sourceRepos: [],
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
    },
    {
      id: 'reg-3',
      repoIdentifier: 'org/frontend',
      workflowName: 'on-release',
      triggerTypes: ['lifecycle'],
      triggers: [],
      lastTriggeredAt: null,
      nextFireAt: null,
      sourceRepos: [],
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
    },
  ];

  function mockSuccessResponse(registrations = sampleRegistrations) {
    const body = JSON.stringify({
      registrations,
      registryVersion: 5,
      registryUpdatedAt: '2026-03-14T08:00:00Z',
    });
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => body,
      json: async () => JSON.parse(body),
    });
  }

  describe('table output', () => {
    it('displays a table with columns: WORKFLOW, REPO, TRIGGERS, LAST TRIGGERED', async () => {
      await writeConfig({
        pat: 'test-pat',
        platformEndpoint: 'https://platform.example.com',
        activeOrgId: 'org-123',
      });
      mockSuccessResponse();

      const result = await workflowsListCommand({});

      expect(result).toBe(true);
      const output = consoleLogSpy.mock.calls.map((c) => c[0]).join('\n');
      expect(output).toContain('WORKFLOW');
      expect(output).toContain('REPO');
      expect(output).toContain('TRIGGERS');
      expect(output).toContain('LAST TRIGGERED');
      expect(output).toContain('deploy-on-event');
      expect(output).toContain('org/infra');
      expect(output).toContain('kici_event');
      expect(output).toContain('nightly-cleanup');
      expect(output).toContain('org/api');
      expect(output).toContain('on-release');
      expect(output).toContain('org/frontend');
    });
  });

  describe('JSON output', () => {
    it('outputs full registration data as JSON array with --json', async () => {
      await writeConfig({
        pat: 'test-pat',
        platformEndpoint: 'https://platform.example.com',
        activeOrgId: 'org-123',
      });
      mockSuccessResponse();

      const result = await workflowsListCommand({ json: true });

      expect(result).toBe(true);
      const output = consoleLogSpy.mock.calls.map((c) => c[0]).join('\n');
      const parsed = JSON.parse(output);
      expect(parsed).toHaveLength(3);
      expect(parsed[0].workflowName).toBe('deploy-on-event');
      expect(parsed[1].workflowName).toBe('nightly-cleanup');
      expect(parsed[2].workflowName).toBe('on-release');
    });
  });

  describe('stale filtering', () => {
    it('filters to only show stale registrations with --stale 30d', async () => {
      await writeConfig({
        pat: 'test-pat',
        platformEndpoint: 'https://platform.example.com',
        activeOrgId: 'org-123',
      });

      const registrations = [
        {
          ...sampleRegistrations[0],
          // Triggered 2 hours ago -- not stale
          lastTriggeredAt: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
        },
        {
          ...sampleRegistrations[1],
          // Triggered 45 days ago -- stale
          lastTriggeredAt: new Date(Date.now() - 45 * 24 * 60 * 60 * 1000).toISOString(),
        },
        {
          ...sampleRegistrations[2],
          // Never triggered -- stale
          lastTriggeredAt: null,
        },
      ];
      mockSuccessResponse(registrations);

      const result = await workflowsListCommand({ stale: '30d' });

      expect(result).toBe(true);
      const output = consoleLogSpy.mock.calls.map((c) => c[0]).join('\n');
      // Should show stale ones
      expect(output).toContain('nightly-cleanup');
      expect(output).toContain('on-release');
      // Should NOT show the recently triggered one
      expect(output).not.toContain('deploy-on-event');
    });
  });

  describe('empty result', () => {
    it('shows "No registered workflows found" when result is empty', async () => {
      await writeConfig({
        pat: 'test-pat',
        platformEndpoint: 'https://platform.example.com',
        activeOrgId: 'org-123',
      });
      mockSuccessResponse([]);

      const result = await workflowsListCommand({});

      expect(result).toBe(true);
      const output = consoleLogSpy.mock.calls.map((c) => c[0]).join('\n');
      expect(output).toContain('No registered workflows found');
    });
  });

  describe('authentication', () => {
    it('shows login prompt when no credentials configured', async () => {
      // No config file at all
      const result = await workflowsListCommand({});

      expect(result).toBe(false);
      const errors = consoleErrorSpy.mock.calls.map((c) => c[0]).join('\n');
      expect(errors).toContain('Not logged in');
      expect(errors).toContain('kici login');
    });

    it('shows login prompt when no org is selected', async () => {
      await writeConfig({
        pat: 'test-pat',
        platformEndpoint: 'https://platform.example.com',
        // No activeOrgId
      });

      const result = await workflowsListCommand({});

      expect(result).toBe(false);
      const errors = consoleErrorSpy.mock.calls.map((c) => c[0]).join('\n');
      expect(errors).toContain('org');
    });
  });

  describe('error handling', () => {
    it('handles 503 (no orchestrator connected) gracefully', async () => {
      await writeConfig({
        pat: 'test-pat',
        platformEndpoint: 'https://platform.example.com',
        activeOrgId: 'org-123',
      });

      mockFetch.mockResolvedValue({
        ok: false,
        status: 503,
        json: async () => ({ error: 'No orchestrator connected' }),
      });

      const result = await workflowsListCommand({});

      expect(result).toBe(false);
      const errors = consoleErrorSpy.mock.calls.map((c) => c[0]).join('\n');
      expect(errors).toContain('orchestrator');
    });
  });
});

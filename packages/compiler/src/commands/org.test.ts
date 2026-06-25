import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

// Mock os module
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

import { orgListCommand, orgUseCommand, orgCurrentCommand } from './org.js';
import { saveGlobalConfig, loadGlobalConfig } from '../remote/config.js';

describe('kici org', () => {
  let tempDir: string;
  let consoleSpy: ReturnType<typeof vi.spyOn>;
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    vi.clearAllMocks();
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kici-org-test-'));
    vi.mocked(os.homedir).mockReturnValue(tempDir);
    consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  describe('orgListCommand', () => {
    it('displays orgs with star for active org', async () => {
      await saveGlobalConfig({
        pat: 'kici_pat_test',
        platformEndpoint: 'https://platform.example.com',
        activeOrgId: 'org-1',
      });

      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => [
          { id: 'org-1', displayName: 'Personal', isOwner: true },
          { id: 'org-2', displayName: 'My team', isOwner: false },
        ],
      });

      const result = await orgListCommand();

      expect(result).toBe(true);
      const output = consoleSpy.mock.calls.map((c) => c.join(' ')).join('\n');
      expect(output).toContain('Personal');
      expect(output).toContain('My team');
      // Active org should have a marker
      expect(output).toMatch(/\*.*Personal/);
      // Ownership column renders owner/member, not (undefined)
      expect(output).toContain('(owner)');
      expect(output).toContain('(member)');
    });

    it('sends PAT as bearer token', async () => {
      await saveGlobalConfig({
        pat: 'kici_pat_auth_test',
        platformEndpoint: 'https://platform.example.com',
      });

      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => [],
      });

      await orgListCommand();

      expect(mockFetch).toHaveBeenCalledWith(
        'https://platform.example.com/api/v1/user/orgs',
        expect.objectContaining({
          headers: expect.objectContaining({
            Authorization: 'Bearer kici_pat_auth_test',
          }),
        }),
      );
    });

    it('prints guidance when no orgs found', async () => {
      await saveGlobalConfig({
        pat: 'kici_pat_test',
        platformEndpoint: 'https://platform.example.com',
      });

      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => [],
      });

      const result = await orgListCommand();

      expect(result).toBe(true);
      const output = consoleSpy.mock.calls.map((c) => c.join(' ')).join('\n');
      expect(output).toMatch(/no organizations/i);
    });

    it('fails gracefully without PAT', async () => {
      await saveGlobalConfig({});

      const result = await orgListCommand();

      expect(result).toBe(false);
      const output = consoleSpy.mock.calls
        .concat(consoleErrorSpy.mock.calls)
        .map((c) => c.join(' '))
        .join('\n');
      expect(output).toMatch(/not logged in/i);
    });

    it('handles 401 response with clear message', async () => {
      await saveGlobalConfig({
        pat: 'kici_pat_expired',
        platformEndpoint: 'https://platform.example.com',
      });

      mockFetch.mockResolvedValue({
        ok: false,
        status: 401,
      });

      const result = await orgListCommand();

      expect(result).toBe(false);
    });
  });

  describe('orgUseCommand', () => {
    it('sets activeOrgId in config by display name (case-insensitive)', async () => {
      await saveGlobalConfig({
        pat: 'kici_pat_test',
        platformEndpoint: 'https://platform.example.com',
      });

      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => [
          { id: 'org-1', displayName: 'Personal', isOwner: true },
          { id: 'org-2', displayName: 'My team', isOwner: false },
        ],
      });

      const result = await orgUseCommand('personal');

      expect(result).toBe(true);
      const config = await loadGlobalConfig();
      expect(config.activeOrgId).toBe('org-1');

      const output = consoleSpy.mock.calls.map((c) => c.join(' ')).join('\n');
      expect(output).toMatch(/Personal/);
    });

    it('sets activeOrgId by ID', async () => {
      await saveGlobalConfig({
        pat: 'kici_pat_test',
        platformEndpoint: 'https://platform.example.com',
      });

      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => [
          { id: 'org-1', displayName: 'Personal', isOwner: true },
          { id: 'org-2', displayName: 'My team', isOwner: false },
        ],
      });

      const result = await orgUseCommand('org-2');

      expect(result).toBe(true);
      const config = await loadGlobalConfig();
      expect(config.activeOrgId).toBe('org-2');
    });

    it('rejects non-existent org', async () => {
      await saveGlobalConfig({
        pat: 'kici_pat_test',
        platformEndpoint: 'https://platform.example.com',
      });

      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => [{ id: 'org-1', displayName: 'Personal', isOwner: true }],
      });

      const result = await orgUseCommand('nonexistent');

      expect(result).toBe(false);
    });

    it('fails gracefully without PAT', async () => {
      await saveGlobalConfig({});

      const result = await orgUseCommand('Personal');

      expect(result).toBe(false);
    });
  });

  describe('orgCurrentCommand', () => {
    it('displays active org ID', async () => {
      await saveGlobalConfig({
        activeOrgId: 'org-123',
      });

      const result = await orgCurrentCommand();

      expect(result).toBe(true);
      const output = consoleSpy.mock.calls.map((c) => c.join(' ')).join('\n');
      expect(output).toContain('org-123');
    });

    it('displays guidance when no active org set', async () => {
      await saveGlobalConfig({});

      const result = await orgCurrentCommand();

      expect(result).toBe(true);
      const output = consoleSpy.mock.calls.map((c) => c.join(' ')).join('\n');
      expect(output).toMatch(/no active org/i);
    });

    it('fetches org name when PAT available', async () => {
      await saveGlobalConfig({
        pat: 'kici_pat_test',
        platformEndpoint: 'https://platform.example.com',
        activeOrgId: 'org-1',
      });

      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => [{ id: 'org-1', displayName: 'Personal', isOwner: true }],
      });

      const result = await orgCurrentCommand();

      expect(result).toBe(true);
      const output = consoleSpy.mock.calls.map((c) => c.join(' ')).join('\n');
      expect(output).toContain('Personal');
    });
  });
});

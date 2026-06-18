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

import { secretsListCommand } from './secrets-list.js';

/** Build a Response-like object DashboardClient understands (reads res.text()). */
function jsonOk(body: unknown) {
  const text = JSON.stringify(body);
  return { ok: true, status: 200, text: async () => text, json: async () => JSON.parse(text) };
}

describe('kici secrets list', () => {
  let tempDir: string;
  let consoleLogSpy: ReturnType<typeof vi.spyOn>;
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kici-secrets-test-'));
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

  const platformConfig = {
    pat: 'kici_pat_abc',
    platformEndpoint: 'https://platform.example.com',
    activeOrgId: 'org-1',
  };

  describe('displays context names and key names', () => {
    it('shows table with contexts and their keys, filtering to allowLocalExecution', async () => {
      await writeConfig(platformConfig);

      mockFetch.mockResolvedValue(
        jsonOk({
          environments: [
            {
              name: 'test-database',
              secretKeys: ['host', 'port', 'password'],
              allowLocalExecution: true,
              enabled: true,
            },
            {
              name: 'staging-api',
              secretKeys: ['api_key'],
              allowLocalExecution: true,
              enabled: false,
            },
            {
              name: 'production',
              secretKeys: ['DB_PASSWORD'],
              allowLocalExecution: false,
              enabled: true,
            },
          ],
        }),
      );

      const result = await secretsListCommand();

      expect(result).toBe(true);
      expect(mockFetch).toHaveBeenCalledWith(
        'https://platform.example.com/api/v1/orgs/org-1/environments?includeSecrets=true',
        expect.objectContaining({
          headers: expect.objectContaining({ Authorization: 'Bearer kici_pat_abc' }),
        }),
      );

      const output = consoleLogSpy.mock.calls.map((c) => c[0]).join('\n');
      expect(output).toContain('test-database');
      expect(output).toContain('host, port, password');
      expect(output).toContain('staging-api');
      expect(output).toContain('api_key');
      // disabled flag shows when enabled=false
      expect(output).toContain('disabled');
      // production env (allowLocalExecution=false) is filtered out
      expect(output).not.toContain('production');
      expect(output).not.toContain('DB_PASSWORD');
    });
  });

  describe('handles empty context list', () => {
    it('shows message when no contexts are available', async () => {
      await writeConfig(platformConfig);
      mockFetch.mockResolvedValue(jsonOk({ environments: [] }));

      const result = await secretsListCommand();

      expect(result).toBe(true);
      const output = consoleLogSpy.mock.calls.map((c) => c[0]).join('\n');
      expect(output).toContain('No test-available secret contexts found');
    });

    it('shows message when no env has allowLocalExecution', async () => {
      await writeConfig(platformConfig);
      mockFetch.mockResolvedValue(
        jsonOk({
          environments: [
            { name: 'production', secretKeys: ['x'], allowLocalExecution: false, enabled: true },
          ],
        }),
      );

      const result = await secretsListCommand();
      expect(result).toBe(true);
      const output = consoleLogSpy.mock.calls.map((c) => c[0]).join('\n');
      expect(output).toContain('No test-available secret contexts found');
      expect(output).toContain('allowLocalExecution');
    });
  });

  describe('handles auth failure', () => {
    it('returns false and shows error on 403', async () => {
      await writeConfig(platformConfig);

      mockFetch.mockResolvedValue({
        ok: false,
        status: 403,
        json: async () => ({ error: 'Insufficient permission: environments.read needed' }),
      });

      const result = await secretsListCommand();

      expect(result).toBe(false);
      const errors = consoleErrorSpy.mock.calls.map((c) => c[0]).join('\n');
      expect(errors).toContain('environments.read');
    });
  });

  describe('handles missing configuration', () => {
    it('returns false when not authenticated', async () => {
      // No config file at all
      const result = await secretsListCommand();

      expect(result).toBe(false);
      const errors = consoleErrorSpy.mock.calls.map((c) => c[0]).join('\n');
      expect(errors).toContain('Not logged in');
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('returns false when no active organization is set', async () => {
      await writeConfig({ pat: 'kici_pat_abc', platformEndpoint: 'https://platform.example.com' });

      const result = await secretsListCommand();

      expect(result).toBe(false);
      const errors = consoleErrorSpy.mock.calls.map((c) => c[0]).join('\n');
      expect(errors).toContain('No active organization');
      expect(mockFetch).not.toHaveBeenCalled();
    });
  });
});

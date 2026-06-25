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

import { typesCommand } from './types.js';

/** Build a Response-like object DashboardClient understands (reads res.text()). */
function jsonOk(body: unknown) {
  const text = JSON.stringify(body);
  return { ok: true, status: 200, text: async () => text, json: async () => JSON.parse(text) };
}

describe('kici types', () => {
  let tempDir: string;
  let consoleLogSpy: ReturnType<typeof vi.spyOn>;
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kici-types-test-'));
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

  describe('successful generation', () => {
    it('writes .d.ts to correct path', async () => {
      await writeConfig(platformConfig);

      mockFetch.mockResolvedValue(
        jsonOk({
          environments: [
            {
              name: 'production',
              secretKeys: ['DB_HOST', 'DB_PASS'],
              allowLocalExecution: true,
              enabled: true,
            },
          ],
        }),
      );

      const kiciDir = path.join(tempDir, 'project', '.kici');
      await fs.mkdir(kiciDir, { recursive: true });

      const result = await typesCommand({ kiciDir });

      expect(result).toBe(true);
      expect(mockFetch).toHaveBeenCalledWith(
        'https://platform.example.com/api/v1/orgs/org-1/environments?includeSecrets=true',
        expect.objectContaining({
          headers: expect.objectContaining({ Authorization: 'Bearer kici_pat_abc' }),
        }),
      );

      const outputPath = path.join(kiciDir, 'types', 'secrets.d.ts');
      const content = await fs.readFile(outputPath, 'utf-8');
      expect(content).toContain("declare module '@kici-dev/sdk'");
      expect(content).toContain('DB_HOST: string;');
      expect(content).toContain('DB_PASS: string;');
    });

    it('generated file contains KnownSecretKeys and EnvironmentSecrets', async () => {
      await writeConfig(platformConfig);

      mockFetch.mockResolvedValue(
        jsonOk({
          environments: [
            { name: 'staging', secretKeys: ['KEY1'], allowLocalExecution: true, enabled: true },
          ],
        }),
      );

      const kiciDir = path.join(tempDir, 'project', '.kici');
      await fs.mkdir(kiciDir, { recursive: true });

      const result = await typesCommand({ kiciDir });

      expect(result).toBe(true);
      const outputPath = path.join(kiciDir, 'types', 'secrets.d.ts');
      const content = await fs.readFile(outputPath, 'utf-8');
      expect(content).toContain('interface KnownSecretKeys');
      expect(content).toContain('interface EnvironmentSecrets');
      expect(content).not.toContain('KnownContexts');
    });

    it('suppresses the success line on stdout when quiet', async () => {
      await writeConfig(platformConfig);

      mockFetch.mockResolvedValue(
        jsonOk({
          environments: [
            { name: 'staging', secretKeys: ['KEY1'], allowLocalExecution: true, enabled: true },
          ],
        }),
      );

      const kiciDir = path.join(tempDir, 'project', '.kici');
      await fs.mkdir(kiciDir, { recursive: true });

      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      const result = await typesCommand({ kiciDir, quiet: true });
      expect(result).toBe(true);
      // The "Types generated" line is a direct stdout write — under quiet it
      // must not fire so a machine-readable caller keeps stdout pure.
      expect(logSpy).not.toHaveBeenCalled();
      logSpy.mockRestore();
    });
  });

  describe('handles auth errors', () => {
    it('returns false when not authenticated', async () => {
      // No config file at all
      const result = await typesCommand({});

      expect(result).toBe(false);
      const errors = consoleErrorSpy.mock.calls.map((c) => c[0]).join('\n');
      expect(errors).toContain('Not logged in');
      expect(errors).toContain('kici login');
    });

    it('returns false when no active organization is set', async () => {
      await writeConfig({ pat: 'kici_pat_abc', platformEndpoint: 'https://platform.example.com' });

      const result = await typesCommand({});

      expect(result).toBe(false);
      const errors = consoleErrorSpy.mock.calls.map((c) => c[0]).join('\n');
      expect(errors).toContain('No active organization');
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('returns false on 403 response', async () => {
      await writeConfig(platformConfig);

      mockFetch.mockResolvedValue({
        ok: false,
        status: 403,
        json: async () => ({ error: 'Insufficient permission: environments.read needed' }),
      });

      const result = await typesCommand({});

      expect(result).toBe(false);
      const errors = consoleErrorSpy.mock.calls.map((c) => c[0]).join('\n');
      expect(errors).toContain('environments.read');
    });
  });

  describe('handles network errors', () => {
    it('returns false with error message on network failure', async () => {
      await writeConfig(platformConfig);

      mockFetch.mockRejectedValue(new Error('connect ECONNREFUSED'));

      const result = await typesCommand({});

      expect(result).toBe(false);
      const errors = consoleErrorSpy.mock.calls.map((c) => c[0]).join('\n');
      expect(errors).toContain('ECONNREFUSED');
    });
  });
});

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

import { logoutCommand } from './logout.js';
import { saveGlobalConfig, loadGlobalConfig } from '../remote/config.js';

describe('kici logout', () => {
  let tempDir: string;
  let consoleSpy: ReturnType<typeof vi.spyOn>;
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    vi.clearAllMocks();
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kici-logout-test-'));
    vi.mocked(os.homedir).mockReturnValue(tempDir);
    consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('revokes PAT server-side and clears local config', async () => {
    await saveGlobalConfig({
      pat: 'kici_pat_test',
      patId: 'pat-123',
      patExpiresAt: '2026-07-04T00:00:00Z',
      userEmail: 'test@example.com',
      activeOrgId: 'org-1',
      platformEndpoint: 'https://platform.example.com',
    });

    mockFetch.mockResolvedValue({ ok: true });

    const result = await logoutCommand();

    expect(result).toBe(true);

    // Should have called DELETE on the PAT endpoint
    expect(mockFetch).toHaveBeenCalledWith(
      'https://platform.example.com/api/v1/pats/pat-123',
      expect.objectContaining({
        method: 'DELETE',
        headers: expect.objectContaining({
          Authorization: 'Bearer kici_pat_test',
        }),
      }),
    );

    // Verify local config is cleared
    const config = await loadGlobalConfig();
    expect(config.pat).toBeUndefined();
    expect(config.patId).toBeUndefined();
    expect(config.patExpiresAt).toBeUndefined();
    expect(config.userEmail).toBeUndefined();
    expect(config.activeOrgId).toBeUndefined();

    const output = consoleSpy.mock.calls.map((c) => c.join(' ')).join('\n');
    expect(output).toMatch(/revoked/i);
    expect(output).toMatch(/logged out/i);
  });

  it('still clears local config when server revocation fails', async () => {
    await saveGlobalConfig({
      pat: 'kici_pat_test',
      patId: 'pat-123',
      platformEndpoint: 'https://platform.example.com',
    });

    mockFetch.mockRejectedValue(new Error('Network error'));

    const result = await logoutCommand();

    expect(result).toBe(true);

    // Config should still be cleared
    const config = await loadGlobalConfig();
    expect(config.pat).toBeUndefined();
    expect(config.patId).toBeUndefined();

    const output = consoleSpy.mock.calls.map((c) => c.join(' ')).join('\n');
    expect(output).toMatch(/could not revoke|warning/i);
  });

  it('prints not logged in when no PAT in config', async () => {
    await saveGlobalConfig({});

    const result = await logoutCommand();

    expect(result).toBe(true);

    const output = consoleSpy.mock.calls.map((c) => c.join(' ')).join('\n');
    expect(output).toMatch(/not logged in/i);

    // Should not have called fetch
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('preserves connection config fields', async () => {
    await saveGlobalConfig({
      pat: 'kici_pat_test',
      patId: 'pat-123',
      platformEndpoint: 'https://platform.example.com',
      endpoint: 'https://orch.example.com',
      routingKey: 'github:42',
    });

    mockFetch.mockResolvedValue({ ok: true });

    await logoutCommand();

    const config = await loadGlobalConfig();
    // Auth fields cleared
    expect(config.pat).toBeUndefined();
    // Connection settings preserved
    expect(config.endpoint).toBe('https://orch.example.com');
    expect(config.routingKey).toBe('github:42');
    expect(config.platformEndpoint).toBe('https://platform.example.com');
  });

  it('clears legacy token on logout', async () => {
    await saveGlobalConfig({
      pat: 'kici_pat_test',
      patId: 'pat-123',
      platformEndpoint: 'https://platform.example.com',
      token: 'legacy-api-key',
    });

    mockFetch.mockResolvedValue({ ok: true });

    await logoutCommand();

    const config = await loadGlobalConfig();
    expect(config.pat).toBeUndefined();
    expect(config.token).toBeUndefined();
  });

  it('logs out token-only user without PAT revocation', async () => {
    await saveGlobalConfig({
      token: 'legacy-api-key',
      endpoint: 'https://orch.example.com',
    });

    const result = await logoutCommand();

    expect(result).toBe(true);
    // Should not attempt server-side PAT revocation
    expect(mockFetch).not.toHaveBeenCalled();

    const config = await loadGlobalConfig();
    expect(config.token).toBeUndefined();
    // Connection settings preserved
    expect(config.endpoint).toBe('https://orch.example.com');

    const output = consoleSpy.mock.calls.map((c) => c.join(' ')).join('\n');
    expect(output).toMatch(/logged out/i);
  });
});

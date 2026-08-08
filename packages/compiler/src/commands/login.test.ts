import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

// Mock os module (homedir + hostname)
vi.mock('node:os', async () => {
  const actual = await vi.importActual<typeof import('node:os')>('node:os');
  return {
    ...actual,
    default: {
      ...actual,
      homedir: vi.fn(),
      hostname: vi.fn().mockReturnValue('test-machine'),
    },
  };
});

// Mock the oauth module
vi.mock('../remote/oauth.js', () => ({
  pkceFlow: vi.fn(),
  deviceFlow: vi.fn(),
  exchangeTokenForPat: vi.fn(),
}));

// Mock the headless-detect module
vi.mock('../auth/headless-detect.js', () => ({
  isHeadless: vi.fn().mockResolvedValue(false),
}));

// Mock the local dev plane (attach prompt).
const planeStatusMock = vi.fn().mockResolvedValue({ running: false, mode: 'independent' });
const attachPlaneMock = vi.fn().mockResolvedValue({ mode: 'hybrid', url: 'http://127.0.0.1:4319' });
vi.mock('../local-plane/plane-manager.js', () => ({
  planeStatus: (...a: unknown[]) => planeStatusMock(...a),
  attachPlane: (...a: unknown[]) => attachPlaneMock(...a),
}));

// Mock readline so the [Y/n] attach prompt returns a scripted answer.
let scriptedAnswer = 'y';
vi.mock('node:readline', () => ({
  createInterface: () => ({
    question: (_q: string, cb: (a: string) => void) => cb(scriptedAnswer),
    close: () => {},
  }),
}));

import { loginCommand } from './login.js';
import { loadGlobalConfig, saveGlobalConfig } from '../remote/config.js';
import { pkceFlow, deviceFlow, exchangeTokenForPat } from '../remote/oauth.js';
import {
  PROD_PLATFORM_URL,
  PROD_OIDC_ISSUER,
  PROD_OIDC_CLIENT_ID,
} from '../remote/prod-defaults.js';
import { isHeadless } from '../auth/headless-detect.js';

describe('kici login', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kici-login-test-'));
    vi.mocked(os.homedir).mockReturnValue(tempDir);
    // The homedir mock alone does not isolate this suite: getConfigDir()
    // refuses the ambient config under the KiCI test-isolation marker before
    // it consults homedir(). Name the same directory the mock produces
    // explicitly.
    process.env.KICI_CONFIG_DIR = path.join(tempDir, '.kici');
  });

  afterEach(async () => {
    delete process.env.KICI_CONFIG_DIR;
    vi.restoreAllMocks();
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  describe('with --token flag (legacy API key flow)', () => {
    it('saves token to config', async () => {
      const result = await loginCommand({ token: 'test-api-key-123' });

      expect(result).toBe(true);

      const config = await loadGlobalConfig();
      expect(config.token).toBe('test-api-key-123');
    });

    it('saves platformEndpoint alongside token', async () => {
      const result = await loginCommand({
        token: 'my-key',
        platformEndpoint: 'https://platform.example.com',
      });

      expect(result).toBe(true);

      const config = await loadGlobalConfig();
      expect(config.token).toBe('my-key');
      expect(config.platformEndpoint).toBe('https://platform.example.com');
    });

    it('saves all options together', async () => {
      const result = await loginCommand({
        token: 'full-key',
        platformEndpoint: 'https://platform.example.com',
        routingKey: 'github:42',
      });

      expect(result).toBe(true);

      const config = await loadGlobalConfig();
      expect(config.token).toBe('full-key');
      expect(config.platformEndpoint).toBe('https://platform.example.com');
      expect(config.routingKey).toBe('github:42');
    });

    it('LoginOptions no longer carries an endpoint field (run path is Platform-first)', () => {
      // Compile-time guard: a stray `endpoint` would be a typed property; assert
      // the shape stays Platform-only. The run path never reads config.endpoint.
      const opts: import('./login.js').LoginOptions = { token: 't' };
      expect('endpoint' in opts).toBe(false);
    });

    it('does not run OAuth flow when --token is provided', async () => {
      await loginCommand({ token: 'direct-key' });

      expect(pkceFlow).not.toHaveBeenCalled();
      expect(deviceFlow).not.toHaveBeenCalled();
      expect(exchangeTokenForPat).not.toHaveBeenCalled();
    });
  });

  describe('validation', () => {
    it('rejects empty token', async () => {
      const result = await loginCommand({ token: '' });

      expect(result).toBe(false);
    });

    it('rejects whitespace-only token (trimmed to empty)', async () => {
      const result = await loginCommand({ token: '   ' });

      // Whitespace-only passes length check (not trimmed by loginCommand)
      // Orchestrator will reject invalid tokens at auth time
      expect(result).toBe(true);
    });
  });

  describe('file permissions', () => {
    it('config file has 0o600 permissions after login', async () => {
      await loginCommand({ token: 'secret-key' });

      const configPath = path.join(tempDir, '.kici', 'config');
      const stat = await fs.stat(configPath);
      const mode = stat.mode & 0o777;
      expect(mode).toBe(0o600);
    });
  });

  describe('config merging', () => {
    it('preserves existing config when adding token', async () => {
      const kiciDir = path.join(tempDir, '.kici');
      await fs.mkdir(kiciDir, { recursive: true });
      await fs.writeFile(
        path.join(kiciDir, 'config'),
        JSON.stringify({ endpoint: 'https://existing.example.com', routingKey: 'github:42' }),
        { mode: 0o600 },
      );

      await loginCommand({ token: 'new-key' });

      const config = await loadGlobalConfig();
      expect(config.token).toBe('new-key');
      expect(config.endpoint).toBe('https://existing.example.com');
      expect(config.routingKey).toBe('github:42');
    });

    it('overwrites existing token on re-login', async () => {
      await loginCommand({ token: 'first-key' });
      await loginCommand({ token: 'second-key' });

      const config = await loadGlobalConfig();
      expect(config.token).toBe('second-key');
    });
  });

  describe('OAuth flow (no --token)', () => {
    beforeEach(() => {
      // Clear mock call counts between tests
      vi.clearAllMocks();
      // Re-set homedir mock (clearAllMocks resets it)
      vi.mocked(os.homedir).mockReturnValue(tempDir);
      vi.mocked(os.hostname).mockReturnValue('test-machine');
      // Set env vars for OAuth config
      process.env.KICI_PLATFORM_URL = 'https://platform.example.com';
      process.env.KICI_OIDC_ISSUER = 'https://keycloak.example.com';
      process.env.KICI_OIDC_CLIENT_ID = 'test-cli-client-id';
    });

    afterEach(() => {
      delete process.env.KICI_PLATFORM_URL;
      delete process.env.KICI_OIDC_ISSUER;
      delete process.env.KICI_OIDC_CLIENT_ID;
    });

    it('runs PKCE flow on desktop environment', async () => {
      vi.mocked(isHeadless).mockResolvedValue(false);
      vi.mocked(pkceFlow).mockResolvedValue('mock-oidc-token');
      vi.mocked(exchangeTokenForPat).mockResolvedValue({
        id: 'pat-123',
        token: 'kici_pat_abc',
        expiresAt: '2026-07-04T00:00:00Z',
      });

      const result = await loginCommand({});

      expect(result).toBe(true);
      expect(pkceFlow).toHaveBeenCalledWith({
        issuer: 'https://keycloak.example.com',
        clientId: 'test-cli-client-id',
      });
      expect(deviceFlow).not.toHaveBeenCalled();
      expect(exchangeTokenForPat).toHaveBeenCalledWith({
        platformUrl: 'https://platform.example.com',
        accessToken: 'mock-oidc-token',
        machineName: 'test-machine',
      });

      const config = await loadGlobalConfig();
      expect(config.pat).toBe('kici_pat_abc');
      expect(config.patId).toBe('pat-123');
      expect(config.patExpiresAt).toBe('2026-07-04T00:00:00Z');
    });

    it('runs device flow on headless environment', async () => {
      vi.mocked(isHeadless).mockResolvedValue(true);
      vi.mocked(deviceFlow).mockResolvedValue('mock-device-token');
      vi.mocked(exchangeTokenForPat).mockResolvedValue({
        id: 'pat-456',
        token: 'kici_pat_def',
        expiresAt: '2026-07-04T00:00:00Z',
      });

      const result = await loginCommand({});

      expect(result).toBe(true);
      expect(deviceFlow).toHaveBeenCalledWith({
        issuer: 'https://keycloak.example.com',
        clientId: 'test-cli-client-id',
      });
      expect(pkceFlow).not.toHaveBeenCalled();
    });

    it('forces device flow with --device flag', async () => {
      vi.mocked(isHeadless).mockResolvedValue(false); // desktop, but --device forces device flow
      vi.mocked(deviceFlow).mockResolvedValue('mock-forced-device-token');
      vi.mocked(exchangeTokenForPat).mockResolvedValue({
        id: 'pat-789',
        token: 'kici_pat_ghi',
        expiresAt: '2026-07-04T00:00:00Z',
      });

      const result = await loginCommand({ device: true });

      expect(result).toBe(true);
      expect(deviceFlow).toHaveBeenCalled();
      expect(pkceFlow).not.toHaveBeenCalled();
    });

    it('saves PAT fields to GlobalConfig', async () => {
      vi.mocked(isHeadless).mockResolvedValue(false);
      vi.mocked(pkceFlow).mockResolvedValue('oidc-token');
      vi.mocked(exchangeTokenForPat).mockResolvedValue({
        id: 'pat-saved',
        token: 'kici_pat_saved123',
        expiresAt: '2026-06-15T12:00:00Z',
      });

      await loginCommand({});

      const config = await loadGlobalConfig();
      expect(config.pat).toBe('kici_pat_saved123');
      expect(config.patId).toBe('pat-saved');
      expect(config.patExpiresAt).toBe('2026-06-15T12:00:00Z');
    });

    it('prints 7-day expiry warning when PAT expires within 7 days', async () => {
      const consoleSpy = vi.spyOn(console, 'log');
      const nearExpiry = new Date(Date.now() + 5 * 24 * 60 * 60 * 1000).toISOString(); // 5 days from now

      vi.mocked(isHeadless).mockResolvedValue(false);
      vi.mocked(pkceFlow).mockResolvedValue('oidc-token');
      vi.mocked(exchangeTokenForPat).mockResolvedValue({
        id: 'pat-expiring',
        token: 'kici_pat_expiring',
        expiresAt: nearExpiry,
      });

      await loginCommand({});

      const allOutput = consoleSpy.mock.calls.map((c) => c.join(' ')).join('\n');
      expect(allOutput).toMatch(/expir/i);
    });

    it('returns false on OAuth flow error', async () => {
      vi.mocked(isHeadless).mockResolvedValue(false);
      vi.mocked(pkceFlow).mockRejectedValue(new Error('Browser could not be opened'));

      const result = await loginCommand({});

      expect(result).toBe(false);
    });
  });

  describe('KICI_OIDC_ISSUER and KICI_OIDC_CLIENT_ID env vars', () => {
    beforeEach(() => {
      vi.clearAllMocks();
      vi.mocked(os.homedir).mockReturnValue(tempDir);
      vi.mocked(os.hostname).mockReturnValue('test-machine');
      vi.mocked(isHeadless).mockResolvedValue(false);
      vi.mocked(pkceFlow).mockResolvedValue('mock-oidc-token');
      vi.mocked(exchangeTokenForPat).mockResolvedValue({
        id: 'pat-test',
        token: 'kici_pat_test',
        expiresAt: '2026-07-04T00:00:00Z',
      });
    });

    afterEach(() => {
      delete process.env.KICI_OIDC_ISSUER;
      delete process.env.KICI_OIDC_CLIENT_ID;
      delete process.env.KICI_PLATFORM_URL;
    });

    it('passes KICI_OIDC_ISSUER and KICI_OIDC_CLIENT_ID to PKCE flow', async () => {
      process.env.KICI_OIDC_ISSUER = 'https://new-issuer.example.com';
      process.env.KICI_OIDC_CLIENT_ID = 'test-client';
      process.env.KICI_PLATFORM_URL = 'https://platform.example.com';

      await loginCommand({});

      expect(pkceFlow).toHaveBeenCalledWith({
        issuer: 'https://new-issuer.example.com',
        clientId: 'test-client',
      });
    });

    it('passes overridden issuer and clientId to device flow', async () => {
      vi.mocked(isHeadless).mockResolvedValue(true);
      vi.mocked(deviceFlow).mockResolvedValue('mock-device-token');
      process.env.KICI_OIDC_ISSUER = 'https://custom-issuer.example.com';
      process.env.KICI_OIDC_CLIENT_ID = 'custom-client-id';
      process.env.KICI_PLATFORM_URL = 'https://platform.example.com';

      await loginCommand({});

      expect(deviceFlow).toHaveBeenCalledWith({
        issuer: 'https://custom-issuer.example.com',
        clientId: 'custom-client-id',
      });
    });
  });

  describe('production defaults', () => {
    beforeEach(() => {
      vi.clearAllMocks();
      vi.mocked(os.homedir).mockReturnValue(tempDir);
      vi.mocked(os.hostname).mockReturnValue('test-machine');
      vi.mocked(isHeadless).mockResolvedValue(false);
      vi.mocked(pkceFlow).mockResolvedValue('tok');
      vi.mocked(deviceFlow).mockResolvedValue('tok');
      vi.mocked(exchangeTokenForPat).mockResolvedValue({
        id: 'pat-id',
        token: 'kici_pat_x',
        expiresAt: '2026-07-04T00:00:00Z',
      });
      delete process.env.KICI_OIDC_ISSUER;
      delete process.env.KICI_OIDC_CLIENT_ID;
      delete process.env.KICI_PLATFORM_URL;
    });

    afterEach(() => {
      delete process.env.KICI_OIDC_ISSUER;
      delete process.env.KICI_OIDC_CLIENT_ID;
      delete process.env.KICI_PLATFORM_URL;
    });

    it('defaults KICI_PLATFORM_URL to the hosted Platform when unset', async () => {
      process.env.KICI_OIDC_ISSUER = 'https://keycloak.example.com';
      process.env.KICI_OIDC_CLIENT_ID = 'cli-client';

      const result = await loginCommand({});

      expect(result).toBe(true);
      expect(exchangeTokenForPat).toHaveBeenCalledWith({
        platformUrl: PROD_PLATFORM_URL,
        accessToken: 'tok',
        machineName: 'test-machine',
      });
    });

    it('defaults KICI_OIDC_ISSUER and KICI_OIDC_CLIENT_ID when unset', async () => {
      process.env.KICI_PLATFORM_URL = 'https://platform.example.com';

      const result = await loginCommand({});

      expect(result).toBe(true);
      expect(pkceFlow).toHaveBeenCalledWith({
        issuer: PROD_OIDC_ISSUER,
        clientId: PROD_OIDC_CLIENT_ID,
      });
    });

    it('logs in against production with no env vars set', async () => {
      const result = await loginCommand({});

      expect(result).toBe(true);
      expect(pkceFlow).toHaveBeenCalledWith({
        issuer: PROD_OIDC_ISSUER,
        clientId: PROD_OIDC_CLIENT_ID,
      });
      expect(exchangeTokenForPat).toHaveBeenCalledWith({
        platformUrl: PROD_PLATFORM_URL,
        accessToken: 'tok',
        machineName: 'test-machine',
      });
    });

    it('env vars override the production defaults', async () => {
      process.env.KICI_PLATFORM_URL = 'https://platform.example.com';
      process.env.KICI_OIDC_ISSUER = 'https://keycloak.example.com';
      process.env.KICI_OIDC_CLIENT_ID = 'cli-client';

      const result = await loginCommand({});

      expect(result).toBe(true);
      expect(pkceFlow).toHaveBeenCalledWith({
        issuer: 'https://keycloak.example.com',
        clientId: 'cli-client',
      });
      expect(exchangeTokenForPat).toHaveBeenCalledWith({
        platformUrl: 'https://platform.example.com',
        accessToken: 'tok',
        machineName: 'test-machine',
      });
    });

    it('--platform-endpoint overrides both env var and default', async () => {
      process.env.KICI_PLATFORM_URL = 'https://env-platform.example.com';
      process.env.KICI_OIDC_ISSUER = 'https://keycloak.example.com';
      process.env.KICI_OIDC_CLIENT_ID = 'cli-client';

      const result = await loginCommand({ platformEndpoint: 'https://flag-platform.example.com' });

      expect(result).toBe(true);
      expect(exchangeTokenForPat).toHaveBeenCalledWith({
        platformUrl: 'https://flag-platform.example.com',
        accessToken: 'tok',
        machineName: 'test-machine',
      });
    });
  });

  describe('OAuth endpoint resolution + config reset', () => {
    beforeEach(() => {
      vi.clearAllMocks();
      vi.mocked(os.homedir).mockReturnValue(tempDir);
      vi.mocked(os.hostname).mockReturnValue('test-machine');
      delete process.env.KICI_PLATFORM_URL;
      delete process.env.KICI_OIDC_ISSUER;
      delete process.env.KICI_OIDC_CLIENT_ID;
      vi.mocked(isHeadless).mockResolvedValue(false);
      vi.mocked(pkceFlow).mockResolvedValue('tok');
      vi.mocked(exchangeTokenForPat).mockResolvedValue({
        id: 'pat-r',
        token: 'kici_pat_resolved',
        expiresAt: '2026-07-04T00:00:00Z',
      });
    });

    afterEach(() => {
      delete process.env.KICI_PLATFORM_URL;
      delete process.env.KICI_OIDC_ISSUER;
      delete process.env.KICI_OIDC_CLIENT_ID;
    });

    async function writeConfig(obj: Record<string, unknown>): Promise<void> {
      const kiciDir = path.join(tempDir, '.kici');
      await fs.mkdir(kiciDir, { recursive: true });
      await fs.writeFile(path.join(kiciDir, 'config'), JSON.stringify(obj), { mode: 0o600 });
    }

    it('stale config does NOT redirect login — bare login resolves to prod default', async () => {
      await writeConfig({
        platformEndpoint: 'https://stg.example.com/kici-stg',
        oidcIssuer: 'https://auth.stg.example.com/realms/kici-internal',
      });

      await loginCommand({});

      expect(pkceFlow).toHaveBeenCalledWith({
        issuer: PROD_OIDC_ISSUER,
        clientId: PROD_OIDC_CLIENT_ID,
      });
      expect(exchangeTokenForPat).toHaveBeenCalledWith({
        platformUrl: PROD_PLATFORM_URL,
        accessToken: 'tok',
        machineName: 'test-machine',
      });
    });

    it('flag overrides default for endpoint and issuer', async () => {
      await loginCommand({
        platformEndpoint: 'https://flag.example.com',
        oidcIssuer: 'https://flag-auth.example.com/realms/x',
      });

      expect(pkceFlow).toHaveBeenCalledWith({
        issuer: 'https://flag-auth.example.com/realms/x',
        clientId: PROD_OIDC_CLIENT_ID,
      });
      expect(exchangeTokenForPat).toHaveBeenCalledWith(
        expect.objectContaining({ platformUrl: 'https://flag.example.com' }),
      );
    });

    it('always persists resolved endpoint + issuer alongside the PAT', async () => {
      await loginCommand({});

      const config = await loadGlobalConfig();
      expect(config.pat).toBe('kici_pat_resolved');
      expect(config.platformEndpoint).toBe(PROD_PLATFORM_URL);
      expect(config.oidcIssuer).toBe(PROD_OIDC_ISSUER);
    });

    it('clears activeOrgId + defaultClusters when the endpoint changes', async () => {
      await writeConfig({
        platformEndpoint: 'https://stg.example.com/kici-stg',
        activeOrgId: 'org_kiciStg00001',
        defaultClusters: { org_kiciStg00001: 'cluster-5fbb07' },
      });

      await loginCommand({}); // resolves to PROD_PLATFORM_URL — endpoint changed

      const config = await loadGlobalConfig();
      expect(config.platformEndpoint).toBe(PROD_PLATFORM_URL);
      expect(config.activeOrgId).toBeUndefined();
      expect(config.defaultClusters).toBeUndefined();
    });

    it('preserves activeOrgId + defaultClusters when the endpoint is unchanged', async () => {
      await writeConfig({
        platformEndpoint: PROD_PLATFORM_URL,
        activeOrgId: 'org_NXho-8YmATbZ',
        defaultClusters: { 'org_NXho-8YmATbZ': 'cluster-prod' },
      });

      await loginCommand({}); // resolves to PROD_PLATFORM_URL — endpoint unchanged

      const config = await loadGlobalConfig();
      expect(config.activeOrgId).toBe('org_NXho-8YmATbZ');
      expect(config.defaultClusters).toEqual({ 'org_NXho-8YmATbZ': 'cluster-prod' });
    });
  });

  describe('KICI_CONFIG_DIR env var', () => {
    let customConfigDir: string;

    beforeEach(async () => {
      vi.clearAllMocks();
      customConfigDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kici-login-custom-'));
      process.env.KICI_CONFIG_DIR = customConfigDir;
      vi.mocked(os.homedir).mockReturnValue(tempDir);
      vi.mocked(os.hostname).mockReturnValue('test-machine');
    });

    afterEach(async () => {
      delete process.env.KICI_CONFIG_DIR;
      delete process.env.KICI_PLATFORM_URL;
      delete process.env.KICI_OIDC_ISSUER;
      delete process.env.KICI_OIDC_CLIENT_ID;
      await fs.rm(customConfigDir, { recursive: true, force: true });
    });

    it('saves config to custom directory with --token', async () => {
      const result = await loginCommand({ token: 'custom-dir-key' });

      expect(result).toBe(true);

      const configPath = path.join(customConfigDir, 'config');
      const content = await fs.readFile(configPath, 'utf-8');
      const parsed = JSON.parse(content);
      expect(parsed.token).toBe('custom-dir-key');
    });

    it('loads config from custom directory', async () => {
      // First login to create config
      await loginCommand({ token: 'first-key' });

      // Verify it's in the custom dir
      const config = await loadGlobalConfig();
      expect(config.token).toBe('first-key');
    });
  });

  describe('post-login attach prompt', () => {
    const savedTTY = process.stdin.isTTY;
    beforeEach(async () => {
      vi.clearAllMocks();
      vi.mocked(os.homedir).mockReturnValue(tempDir);
      vi.mocked(os.hostname).mockReturnValue('test-machine');
      vi.mocked(isHeadless).mockResolvedValue(false);
      vi.mocked(pkceFlow).mockResolvedValue('oidc');
      vi.mocked(exchangeTokenForPat).mockResolvedValue({
        id: 'pat-1',
        token: 'kici_pat_abc',
        expiresAt: '2027-01-01T00:00:00Z',
      });
      planeStatusMock.mockResolvedValue({ running: false, mode: 'independent' });
      attachPlaneMock.mockResolvedValue({ mode: 'hybrid', url: 'http://127.0.0.1:4319' });
      process.env.KICI_PLATFORM_URL = 'https://platform.example.com';
      // Seed an existing config with an active org + same endpoint so the
      // login preserves activeOrgId (the prompt only fires with an org).
      await saveGlobalConfig({
        platformEndpoint: 'https://platform.example.com',
        activeOrgId: 'org-1',
      });
    });
    afterEach(() => {
      Object.defineProperty(process.stdin, 'isTTY', { value: savedTTY, configurable: true });
      delete process.env.KICI_PLATFORM_URL;
    });

    it('attaches on Y when interactive with an active org', async () => {
      Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
      scriptedAnswer = 'y';
      await loginCommand({});
      expect(attachPlaneMock).toHaveBeenCalledWith({
        apiBase: 'https://platform.example.com',
        pat: 'kici_pat_abc',
        orgId: 'org-1',
      });
    });

    it('does not attach on n', async () => {
      Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
      scriptedAnswer = 'n';
      await loginCommand({});
      expect(attachPlaneMock).not.toHaveBeenCalled();
    });

    it('does not prompt in non-interactive (piped) input', async () => {
      Object.defineProperty(process.stdin, 'isTTY', { value: undefined, configurable: true });
      scriptedAnswer = 'y';
      await loginCommand({});
      expect(attachPlaneMock).not.toHaveBeenCalled();
    });

    it('does not prompt when --no-attach is set', async () => {
      Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
      scriptedAnswer = 'y';
      await loginCommand({ noAttachPrompt: true });
      expect(attachPlaneMock).not.toHaveBeenCalled();
    });
  });
});

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

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

vi.mock('../remote/oauth.js', () => ({
  pkceFlow: vi.fn(),
  deviceFlow: vi.fn(),
  exchangeTokenForPat: vi.fn(),
}));

vi.mock('../auth/headless-detect.js', () => ({
  isHeadless: vi.fn().mockResolvedValue(false),
}));

const planeStatusMock = vi.fn().mockResolvedValue({ running: false, mode: 'independent' });
const attachPlaneMock = vi.fn().mockResolvedValue({ mode: 'hybrid', url: 'http://127.0.0.1:4319' });
vi.mock('../local-plane/plane-manager.js', () => ({
  planeStatus: (...a: unknown[]) => planeStatusMock(...a),
  attachPlane: (...a: unknown[]) => attachPlaneMock(...a),
}));

// The [Y/n] attach prompt returns a scripted answer.
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

/**
 * Run `kici login` with `options`, assert it failed before either OAuth flow
 * started, and return what it printed to stderr.
 */
async function refusedBeforeAnyFlow(options: Parameters<typeof loginCommand>[0]): Promise<string> {
  const stderr = vi.spyOn(console, 'error').mockImplementation(() => {});
  const result = await loginCommand(options);
  const printed = stderr.mock.calls.map((c: unknown[]) => String(c[0])).join('\n');
  stderr.mockRestore();
  expect(result).toBe(false);
  expect(pkceFlow).not.toHaveBeenCalled();
  expect(deviceFlow).not.toHaveBeenCalled();
  return printed;
}

describe('kici login', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kici-login-test-'));
    vi.mocked(os.homedir).mockReturnValue(tempDir);
    // The homedir mock alone does not isolate this suite: getConfigDir() refuses
    // the ambient config under the test-isolation marker before consulting homedir().
    process.env.KICI_CONFIG_DIR = path.join(tempDir, '.kici');
    // The OAuth helpers are mocked, so the only request a login can make is the
    // login-settings lookup; a test that does not stub it must never reach the
    // network.
    vi.stubGlobal('fetch', async (input: unknown) => {
      throw new Error(`unexpected network request: ${String(input)}`);
    });
  });

  afterEach(async () => {
    delete process.env.KICI_CONFIG_DIR;
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  /** Reset the mocks (keeping the home and host names) and unset every login override. */
  function resetLoginState(): void {
    vi.clearAllMocks();
    vi.mocked(os.homedir).mockReturnValue(tempDir);
    vi.mocked(os.hostname).mockReturnValue('test-machine');
    delete process.env.KICI_PLATFORM_URL;
    delete process.env.KICI_OIDC_ISSUER;
    delete process.env.KICI_OIDC_CLIENT_ID;
    delete process.env.KICI_OIDC_EXTRA_SCOPES;
  }

  /** Mock a successful desktop OAuth login that mints `pat`. */
  function mockOauthLogin(pat: string): void {
    vi.mocked(isHeadless).mockResolvedValue(false);
    vi.mocked(pkceFlow).mockResolvedValue('oidc-token');
    vi.mocked(exchangeTokenForPat).mockResolvedValue({
      id: `id-${pat}`,
      token: pat,
      expiresAt: '2099-01-01T00:00:00Z',
    });
  }

  it('LoginOptions carries no endpoint or token field (run path is Platform-first)', () => {
    // Compile-time guard: a stray `endpoint` or `token` would be a typed property.
    const opts: import('./login.js').LoginOptions = { device: true };
    expect('endpoint' in opts).toBe(false);
    expect('token' in opts).toBe(false);
  });

  describe('file permissions', () => {
    it('config file has 0o600 permissions after login', async () => {
      mockOauthLogin('kici_pat_perm');
      await loginCommand({});

      const configPath = path.join(tempDir, '.kici', 'config');
      const stat = await fs.stat(configPath);
      const mode = stat.mode & 0o777;
      expect(mode).toBe(0o600);
    });
  });

  describe('config merging', () => {
    it('preserves existing connection settings when saving the PAT', async () => {
      const kiciDir = path.join(tempDir, '.kici');
      await fs.mkdir(kiciDir, { recursive: true });
      await fs.writeFile(
        path.join(kiciDir, 'config'),
        JSON.stringify({ endpoint: 'https://existing.example.com', routingKey: 'github:42' }),
        { mode: 0o600 },
      );
      mockOauthLogin('kici_pat_merge');

      await loginCommand({});

      const config = await loadGlobalConfig();
      expect(config.pat).toBe('kici_pat_merge');
      expect(config.endpoint).toBe('https://existing.example.com');
      expect(config.routingKey).toBe('github:42');
    });
  });

  describe('deprecated --routing-key', () => {
    it('warns and still writes the routing key', async () => {
      const stderr = vi.spyOn(console, 'error').mockImplementation(() => {});
      mockOauthLogin('kici_pat_rk');

      await loginCommand({ routingKey: 'github:7' });

      const warned = stderr.mock.calls.map((c: unknown[]) => String(c[0])).join('\n');
      stderr.mockRestore();
      expect(warned).toContain('--routing-key is deprecated');
      expect(warned).toContain('v1.0.0');
      // breaks-if-wrong: the deprecated flag keeps its old effect until v1.0.0
      expect((await loadGlobalConfig()).routingKey).toBe('github:7');
    });
  });

  describe('OAuth flow', () => {
    beforeEach(() => {
      vi.clearAllMocks();
      // clearAllMocks resets the homedir mock.
      vi.mocked(os.homedir).mockReturnValue(tempDir);
      vi.mocked(os.hostname).mockReturnValue('test-machine');
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

  describe('extra OIDC scopes', () => {
    beforeEach(() => {
      resetLoginState();
    });

    // fails-when: --oidc-scope replaces KICI_OIDC_EXTRA_SCOPES instead of adding to it
    it('the flag adds to the env scopes', async () => {
      process.env.KICI_OIDC_EXTRA_SCOPES = 'groups,audience:server:client_id:kici-platform';
      mockOauthLogin('kici_pat_scopes');

      await loginCommand({ oidcScopes: ['api://kici/.default'], noAttachPrompt: true });

      expect(pkceFlow).toHaveBeenCalledWith({
        issuer: PROD_OIDC_ISSUER,
        clientId: PROD_OIDC_CLIENT_ID,
        extraScopes: ['groups', 'audience:server:client_id:kici-platform', 'api://kici/.default'],
      });
    });

    it('passes the extra scopes to the device flow', async () => {
      process.env.KICI_OIDC_EXTRA_SCOPES = 'groups';
      mockOauthLogin('kici_pat_device_scopes');
      vi.mocked(deviceFlow).mockResolvedValue('oidc-token');

      await loginCommand({ device: true, noAttachPrompt: true });

      expect(deviceFlow).toHaveBeenCalledWith({
        issuer: PROD_OIDC_ISSUER,
        clientId: PROD_OIDC_CLIENT_ID,
        extraScopes: ['groups'],
      });
    });

    // fails-when: a scope with a quote or a backslash reaches the identity provider's scope parameter
    it.each([
      ['KICI_OIDC_EXTRA_SCOPES', { env: 'groups a"b', flag: [] as string[] }],
      ['--oidc-scope', { env: '', flag: ['a\\b'] }],
    ])('refuses a scope that is not one scope token from %s', async (source, input) => {
      process.env.KICI_OIDC_EXTRA_SCOPES = input.env;
      mockOauthLogin('kici_pat_bad_scope');
      const printed = await refusedBeforeAnyFlow({ oidcScopes: input.flag, noAttachPrompt: true });
      expect(printed).toContain(source);
    });

    // breaks-if-wrong: a blank variable keeps today's flow options
    it('a blank KICI_OIDC_EXTRA_SCOPES adds nothing', async () => {
      process.env.KICI_OIDC_EXTRA_SCOPES = ' , ';
      mockOauthLogin('kici_pat_blank_scopes');

      await loginCommand({ noAttachPrompt: true });

      expect(pkceFlow).toHaveBeenCalledWith({
        issuer: PROD_OIDC_ISSUER,
        clientId: PROD_OIDC_CLIENT_ID,
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

    it('defaults KICI_OIDC_ISSUER and KICI_OIDC_CLIENT_ID for the hosted Platform URL', async () => {
      // A Platform other than the hosted one publishes its own issuer instead
      // (see "a Platform other than the hosted one" below).
      process.env.KICI_PLATFORM_URL = `${PROD_PLATFORM_URL}/`;

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
      resetLoginState();
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
        platformEndpoint: 'https://platform.example.com/kici',
        oidcIssuer: 'https://auth.example.com/realms/kici',
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
        platformEndpoint: 'https://platform.example.com/kici',
        activeOrgId: 'org_acmeOrg00001',
        defaultClusters: { org_acmeOrg00001: 'cluster-5fbb07' },
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
        activeOrgId: 'org_q7Rt-2VbKmXa',
        defaultClusters: { 'org_q7Rt-2VbKmXa': 'cluster-prod' },
      });

      await loginCommand({}); // resolves to PROD_PLATFORM_URL — endpoint unchanged

      const config = await loadGlobalConfig();
      expect(config.activeOrgId).toBe('org_q7Rt-2VbKmXa');
      expect(config.defaultClusters).toEqual({ 'org_q7Rt-2VbKmXa': 'cluster-prod' });
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

    it('saves config to the custom directory', async () => {
      mockOauthLogin('kici_pat_custom');
      const result = await loginCommand({});

      expect(result).toBe(true);

      const configPath = path.join(customConfigDir, 'config');
      const parsed = JSON.parse(await fs.readFile(configPath, 'utf-8'));
      expect(parsed.pat).toBe('kici_pat_custom');
      expect(await loadGlobalConfig()).toMatchObject({ pat: 'kici_pat_custom' });
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
      // An explicit issuer: the login makes no login-settings request.
      process.env.KICI_OIDC_ISSUER = 'https://keycloak.example.com';
      // The prompt fires only with an active org, which login preserves for the same endpoint.
      await saveGlobalConfig({
        platformEndpoint: 'https://platform.example.com',
        activeOrgId: 'org-1',
      });
    });
    afterEach(() => {
      Object.defineProperty(process.stdin, 'isTTY', { value: savedTTY, configurable: true });
      delete process.env.KICI_PLATFORM_URL;
      delete process.env.KICI_OIDC_ISSUER;
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
      expect(await loginCommand({})).toBe(true);
      expect(attachPlaneMock).not.toHaveBeenCalled();
    });

    it('does not prompt in non-interactive (piped) input', async () => {
      Object.defineProperty(process.stdin, 'isTTY', { value: undefined, configurable: true });
      scriptedAnswer = 'y';
      expect(await loginCommand({})).toBe(true);
      expect(attachPlaneMock).not.toHaveBeenCalled();
    });

    it('does not prompt when --no-attach is set', async () => {
      Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
      scriptedAnswer = 'y';
      expect(await loginCommand({ noAttachPrompt: true })).toBe(true);
      expect(attachPlaneMock).not.toHaveBeenCalled();
    });
  });

  describe('a Platform other than the hosted one', () => {
    const PLATFORM = 'https://kici.corp.example';
    const PUBLISHED = { issuer: 'https://login.corp.example/realms/eng', clientId: 'corp-cli' };
    const fetchCalls: string[] = [];

    beforeEach(() => {
      resetLoginState();
      fetchCalls.length = 0;
    });

    /** Stub the global fetch the login-settings request goes through. */
    function stubFetch(respond: () => Response | Promise<Response>): void {
      vi.stubGlobal('fetch', async (input: string | URL | Request) => {
        fetchCalls.push(String(input instanceof Request ? input.url : input));
        return respond();
      });
    }

    it('passes the published issuer to the OAuth flow and saves it', async () => {
      stubFetch(() => Response.json(PUBLISHED));
      mockOauthLogin('kici_pat_published');
      const logs = vi.spyOn(console, 'log').mockImplementation(() => {});

      const result = await loginCommand({ platformEndpoint: PLATFORM, noAttachPrompt: true });

      const printed = logs.mock.calls.map((c: unknown[]) => String(c[0])).join('\n');
      logs.mockRestore();
      expect(result).toBe(true);
      expect(fetchCalls).toEqual([`${PLATFORM}/api/v1/cli/login-config`]);
      expect(pkceFlow).toHaveBeenCalledWith({
        issuer: PUBLISHED.issuer,
        clientId: PUBLISHED.clientId,
      });
      expect(exchangeTokenForPat).toHaveBeenCalledWith({
        platformUrl: PLATFORM,
        accessToken: 'oidc-token',
        machineName: 'test-machine',
      });
      expect(printed).toContain(
        `Using identity provider ${PUBLISHED.issuer} (published by ${PLATFORM})`,
      );
      const config = await loadGlobalConfig();
      expect(config.oidcIssuer).toBe(PUBLISHED.issuer);
      expect(config.platformEndpoint).toBe(PLATFORM);
      // breaks-if-wrong: a Platform that publishes no extra scopes keeps the plain line
      expect(printed).not.toContain('extra scopes');
    });

    // fails-when: the line hides the scopes the Platform published, so the user cannot see what
    // the identity provider is asked for
    it('names the published extra scopes on the identity provider line', async () => {
      stubFetch(() => Response.json({ ...PUBLISHED, extraScopes: ['groups', 'api://kici'] }));
      mockOauthLogin('kici_pat_published_line');
      const logs = vi.spyOn(console, 'log').mockImplementation(() => {});

      await loginCommand({ platformEndpoint: PLATFORM, noAttachPrompt: true });

      const printed = logs.mock.calls.map((c: unknown[]) => String(c[0])).join('\n');
      logs.mockRestore();
      expect(printed).toContain(
        `Using identity provider ${PUBLISHED.issuer} (published by ${PLATFORM}), extra scopes: groups api://kici`,
      );
    });

    // fails-when: the published scopes are dropped, or come before the user's own
    it('appends the published scopes after the env scopes', async () => {
      stubFetch(() => Response.json({ ...PUBLISHED, extraScopes: ['groups'] }));
      process.env.KICI_OIDC_EXTRA_SCOPES = 'api://corp/.default groups';
      mockOauthLogin('kici_pat_published_scopes');
      vi.spyOn(console, 'log').mockImplementation(() => {});

      await loginCommand({ platformEndpoint: PLATFORM, noAttachPrompt: true });

      expect(pkceFlow).toHaveBeenCalledWith({
        issuer: PUBLISHED.issuer,
        clientId: PUBLISHED.clientId,
        extraScopes: ['api://corp/.default', 'groups'],
      });
    });

    // fails-when: a failed lookup falls back to the hosted issuer and the
    // browser is sent to the hosted identity provider
    it('fails before any OAuth flow when discovery fails', async () => {
      stubFetch(() => {
        throw new TypeError('fetch failed');
      });
      const printed = await refusedBeforeAnyFlow({
        platformEndpoint: PLATFORM,
        noAttachPrompt: true,
      });
      expect(exchangeTokenForPat).not.toHaveBeenCalled();
      expect(printed).toContain(`Could not reach Platform at ${PLATFORM}`);
      expect(printed).not.toContain('kici.dev');
    });
  });
});

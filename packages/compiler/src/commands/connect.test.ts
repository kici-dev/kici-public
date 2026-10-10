import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { loadGlobalConfig, saveGlobalConfig } from '../remote/config.js';
import { AuthenticationError } from '../remote/platform-client.js';
import { DirectApiUnavailableError, type DirectWhoami } from '../remote/direct-client.js';
import { connectCommand, disconnectCommand } from './connect.js';

const info = vi.fn();
const error = vi.fn();
vi.mock('@kici-dev/core', async (orig) => {
  const actual = await orig<typeof import('@kici-dev/core')>();
  return {
    ...actual,
    logger: { info: (m: string) => info(m), error: (m: string) => error(m), warn: vi.fn() },
  };
});

const ME: DirectWhoami = {
  tokenId: 'tok-1',
  label: 'dev',
  subject: 'dev@x',
  role: 'admin',
  mode: 'independent',
  orgId: '__default__',
  permissions: { trigger: true, read: true },
};

const plain = (fn: ReturnType<typeof vi.fn>) =>
  fn.mock.calls.map((c) => String(c[0]).replace(/\u001b\[[0-9;]*m/g, '')).join('\n');

let dir: string;
let saved: string | undefined;
beforeEach(async () => {
  info.mockReset();
  error.mockReset();
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'kici-connect-'));
  saved = process.env.KICI_CONFIG_DIR;
  process.env.KICI_CONFIG_DIR = dir;
});
afterEach(async () => {
  if (saved === undefined) delete process.env.KICI_CONFIG_DIR;
  else process.env.KICI_CONFIG_DIR = saved;
  await fs.rm(dir, { recursive: true, force: true });
});

describe('connectCommand', () => {
  it('verifies a stdin token, saves the normalized target and names the caller', async () => {
    const whoami = vi.fn(async () => ME);
    const ok = await connectCommand(
      'https://ci.example.com/',
      { tokenStdin: true },
      { whoami, readStdin: async () => 'tok-value\n', env: {} },
    );
    expect(ok).toBe(true);
    expect(whoami).toHaveBeenCalledWith('https://ci.example.com', 'tok-value');
    expect((await loadGlobalConfig()).direct).toEqual({
      url: 'https://ci.example.com',
      token: 'tok-value',
    });
    expect(plain(info)).toContain(
      'Connected to https://ci.example.com as dev@x (role admin, orchestrator mode independent, organization __default__)',
    );
  });

  it('takes the token from KICI_ORCHESTRATOR_TOKEN without --token-stdin', async () => {
    const whoami = vi.fn(async () => ME);
    const ok = await connectCommand(
      'https://ci.example.com',
      {},
      { whoami, env: { KICI_ORCHESTRATOR_TOKEN: 'env-tok' }, isTty: false },
    );
    expect(ok).toBe(true);
    expect(whoami).toHaveBeenCalledWith('https://ci.example.com', 'env-tok');
  });

  it('refuses with no token on a non-terminal and names both sources', async () => {
    const ok = await connectCommand('https://ci.example.com', {}, { env: {}, isTty: false });
    expect(ok).toBe(false);
    expect(plain(error)).toContain('--token-stdin');
    expect(plain(error)).toContain('KICI_ORCHESTRATOR_TOKEN');
  });

  it('saves nothing when the orchestrator refuses the token', async () => {
    await saveGlobalConfig({ pat: 'keep' });
    const ok = await connectCommand(
      'https://ci.example.com',
      { tokenStdin: true },
      {
        whoami: async () => {
          throw new AuthenticationError('refused');
        },
        readStdin: async () => 'bad',
      },
    );
    expect(ok).toBe(false);
    // fails-when: an unverified token is saved and every later run fails with 401
    expect(await loadGlobalConfig()).toEqual({ pat: 'keep' });
  });

  it('names KICI_SECRET_KEY when the orchestrator serves no test-run API', async () => {
    const ok = await connectCommand(
      'https://ci.example.com',
      { tokenStdin: true },
      {
        whoami: async () => {
          throw new DirectApiUnavailableError('https://ci.example.com');
        },
        readStdin: async () => 't',
      },
    );
    expect(ok).toBe(false);
    expect(plain(error)).toContain('KICI_SECRET_KEY');
  });

  it('saves an auditor token with a note that it cannot start runs', async () => {
    const ok = await connectCommand(
      'https://ci.example.com',
      { tokenStdin: true },
      {
        whoami: async () => ({
          ...ME,
          role: 'auditor',
          permissions: { trigger: false, read: true },
        }),
        readStdin: async () => 'aud',
      },
    );
    expect(ok).toBe(true);
    expect(plain(info)).toContain('can follow runs but not start them');
  });

  it('rejects a URL that is not http(s)', async () => {
    expect(
      await connectCommand('ftp://h', { tokenStdin: true }, { readStdin: async () => 't' }),
    ).toBe(false);
  });
});

describe('disconnectCommand', () => {
  it('removes only the direct target', async () => {
    await saveGlobalConfig({
      pat: 'p',
      platformEndpoint: 'https://api.kici.dev',
      activeOrgId: 'org_1',
      direct: { url: 'https://ci.example.com', token: 't' },
    });
    expect(await disconnectCommand()).toBe(true);
    // breaks-if-wrong: disconnect never logs the user out of the Platform
    expect(await loadGlobalConfig()).toEqual({
      pat: 'p',
      platformEndpoint: 'https://api.kici.dev',
      activeOrgId: 'org_1',
    });
  });

  it('says so when nothing is connected', async () => {
    expect(await disconnectCommand()).toBe(true);
    expect(plain(info)).toContain('No orchestrator is connected.');
  });
});

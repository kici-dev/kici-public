import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs, { readFileSync } from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import path, { dirname, resolve } from 'node:path';

// The prompt layer is mocked so the wizard can be driven headlessly. The pure
// helpers below (formatSourceAddHint, checkPrivateKeyReadable) touch none of it.
vi.mock('./prompts.js', () => ({
  promptDbUrl: vi.fn(async () => 'postgresql://kici:pw@localhost:5432/kici'),
  promptPort: vi.fn(async () => 4000),
  promptConfirm: vi.fn(async () => true),
  promptUrl: vi.fn(async () => 'https://observed.example.com'),
  promptOptionalUrl: vi.fn(async () => undefined),
  promptSecret: vi.fn(async () => 'secret'),
  promptSelect: vi.fn(async () => 'hybrid'),
}));
vi.mock('@inquirer/prompts', () => ({ input: vi.fn(async () => '') }));

import {
  DEFAULT_PLATFORM_RELAY_URL,
  formatSourceAddHint,
  checkPrivateKeyReadable,
  runOrchestratorWizard,
} from './orchestrator-wizard.js';
import { promptConfirm, promptOptionalUrl, promptSelect, promptUrl } from './prompts.js';

const here = dirname(fileURLToPath(import.meta.url));
// wizard -> cli -> src -> orchestrator -> packages -> <repo root>
const composePath = resolve(here, '../../../../../examples/quickstart/compose/docker-compose.yaml');

/** Extract the KICI_PLATFORM_URL value from the quickstart compose file. */
function quickstartPlatformUrl(): string {
  const text = readFileSync(composePath, 'utf8');
  const match = text.match(/KICI_PLATFORM_URL:\s*(\S+)/);
  if (!match) {
    throw new Error(`KICI_PLATFORM_URL not found in ${composePath}`);
  }
  return match[1];
}

describe('DEFAULT_PLATFORM_RELAY_URL', () => {
  it('is the canonical hosted Platform relay endpoint', () => {
    expect(DEFAULT_PLATFORM_RELAY_URL).toBe('wss://api.kici.dev/ws');
  });

  it('matches the quickstart compose KICI_PLATFORM_URL (cannot drift)', () => {
    expect(DEFAULT_PLATFORM_RELAY_URL).toBe(quickstartPlatformUrl());
  });

  it('does not point at the nonexistent platform.kici.dev host', () => {
    expect(DEFAULT_PLATFORM_RELAY_URL).not.toContain('platform.kici.dev');
  });
});

describe('formatSourceAddHint', () => {
  const base = { name: 'main-org', appId: '12345', privateKeyPath: '/home/op/key.pem' };

  it('emits the inline source add command with the webhook secret', () => {
    const lines = formatSourceAddHint({ ...base, webhookSecret: 's3cr3t' }).join('\n');
    expect(lines).toContain('kici-admin source add github');
    expect(lines).toContain("--name 'main-org'");
    expect(lines).toContain('--app-id 12345');
    expect(lines).toContain("--private-key '@/home/op/key.pem'");
    expect(lines).toContain("--webhook-secret 's3cr3t'");
  });

  it('emits a secure-alternative stdin form when a secret is present', () => {
    const lines = formatSourceAddHint({ ...base, webhookSecret: 's3cr3t' }).join('\n');
    expect(lines).toContain("printf %s 's3cr3t' | kici-admin source add github");
    expect(lines).toContain('--webhook-secret -');
  });

  it('omits the webhook-secret flag and the secure-alternative block when no secret', () => {
    const lines = formatSourceAddHint(base).join('\n');
    expect(lines).not.toContain('--webhook-secret');
    expect(lines).not.toContain('Secure alternative');
  });

  it('shell-escapes a secret containing a single quote', () => {
    const lines = formatSourceAddHint({ ...base, webhookSecret: "o'brien" }).join('\n');
    expect(lines).toContain("--webhook-secret 'o'\\''brien'");
  });
});

describe('checkPrivateKeyReadable', () => {
  it('returns null for a readable file', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kici-key-'));
    const keyPath = path.join(dir, 'k.pem');
    fs.writeFileSync(keyPath, 'x');
    try {
      expect(await checkPrivateKeyReadable(keyPath)).toBeNull();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns a warning naming the path when it is not readable', async () => {
    const missing = path.join(os.tmpdir(), 'kici-does-not-exist-xyz.pem');
    const warning = await checkPrivateKeyReadable(missing);
    expect(warning).toContain(missing);
    expect(warning).toMatch(/not readable/);
  });
});

describe('runOrchestratorWizard — mode prompt', () => {
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.mocked(promptSelect).mockResolvedValue('hybrid');
    vi.mocked(promptOptionalUrl).mockResolvedValue(undefined);
    // The last confirm in the wizard asks whether to add a GitHub App source;
    // the earlier two accept the generated secrets. Decline the source.
    vi.mocked(promptConfirm).mockImplementation(
      async (_msg: string, def?: boolean) => def !== false,
    );
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    logSpy.mockRestore();
    vi.clearAllMocks();
  });

  it('offers hybrid first, labels it recommended, and defaults to it', async () => {
    await runOrchestratorWizard();
    const [, choices, defaultValue] = vi.mocked(promptSelect).mock.calls[0];
    expect(choices.map((c) => c.value)).toEqual(['hybrid', 'platform', 'observed', 'independent']);
    expect(choices[0].name).toContain('recommended');
    expect(defaultValue).toBe('hybrid');
  });

  it('preselects the mode the install command passed through', async () => {
    await runOrchestratorWizard({ defaultMode: 'independent' });
    expect(vi.mocked(promptSelect).mock.calls[0][2]).toBe('independent');
  });

  it('asks for a skippable public ingress base in hybrid mode', async () => {
    const cfg = await runOrchestratorWizard();
    expect(promptOptionalUrl).toHaveBeenCalledTimes(1);
    expect(vi.mocked(promptOptionalUrl).mock.calls[0][0]).toMatch(/optional/i);
    // An empty answer leaves the mode hybrid with no advertised ingress —
    // identical to platform-relay behaviour, plus a served-but-unadvertised route.
    expect(cfg.mode).toBe('hybrid');
    expect(cfg.webhookPublicUrl).toBeUndefined();
  });

  it('carries the ingress base through when the operator supplies one', async () => {
    vi.mocked(promptOptionalUrl).mockResolvedValue('https://ci.example.com');
    const cfg = await runOrchestratorWizard();
    expect(cfg.webhookPublicUrl).toBe('https://ci.example.com');
  });

  it('still requires the public base URL in observed mode', async () => {
    vi.mocked(promptSelect).mockResolvedValue('observed');
    const cfg = await runOrchestratorWizard();
    expect(promptOptionalUrl).not.toHaveBeenCalled();
    expect(promptUrl).toHaveBeenCalled();
    expect(cfg.webhookPublicUrl).toBe('https://observed.example.com');
  });

  it('asks for no ingress base in platform mode', async () => {
    vi.mocked(promptSelect).mockResolvedValue('platform');
    const cfg = await runOrchestratorWizard();
    expect(promptOptionalUrl).not.toHaveBeenCalled();
    expect(cfg.webhookPublicUrl).toBeUndefined();
  });
});

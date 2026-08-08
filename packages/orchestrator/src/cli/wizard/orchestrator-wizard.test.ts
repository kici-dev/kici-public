import { describe, it, expect } from 'vitest';
import fs, { readFileSync } from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import path, { dirname, resolve } from 'node:path';
import {
  DEFAULT_PLATFORM_RELAY_URL,
  formatSourceAddHint,
  checkPrivateKeyReadable,
} from './orchestrator-wizard.js';

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

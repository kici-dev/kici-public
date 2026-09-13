import { describe, it, expect, vi } from 'vitest';
import { assertPayloadsAvailable } from './availability.js';
import type { AgentPackageDownloadStorage } from './download.js';
import { agentPackageKey } from './upload.js';

/** A store whose `has` returns true only for keys in `present`. */
function storeWith(present: Set<string>): AgentPackageDownloadStorage {
  return {
    getUrl: vi.fn(),
    get: vi.fn(),
    has: vi.fn(async (key: string) => present.has(key)),
  };
}

describe('assertPayloadsAvailable', () => {
  it('reports available when every platform payload exists', async () => {
    const present = new Set([
      agentPackageKey('1.2.3', 'linux-x64'),
      agentPackageKey('1.2.3', 'linux-arm64'),
    ]);
    const res = await assertPayloadsAvailable(storeWith(present), '1.2.3', [
      'linux-x64',
      'linux-arm64',
    ]);
    expect(res).toEqual({ available: true, missing: [] });
  });

  it('reports the missing platform(s) — fail-closed, never throws', async () => {
    const present = new Set([agentPackageKey('1.2.3', 'linux-x64')]);
    const res = await assertPayloadsAvailable(storeWith(present), '1.2.3', [
      'linux-x64',
      'linux-arm64',
    ]);
    expect(res).toEqual({ available: false, missing: ['linux-arm64'] });
  });

  it('reports all missing for a version with no uploaded payloads', async () => {
    const res = await assertPayloadsAvailable(storeWith(new Set()), '9.9.9', [
      'linux-x64',
      'linux-arm64',
    ]);
    expect(res.available).toBe(false);
    expect(res.missing).toEqual(['linux-x64', 'linux-arm64']);
  });
});

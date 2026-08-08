import { describe, it, expect } from 'vitest';
import { createSandboxAllowListReader } from './sandbox-allowlist-reader.js';

/**
 * Fake Kysely handle: only the `selectFrom('org_settings').select(...)
 * .where(...).executeTakeFirst()` chain the reader uses is modelled. The
 * executeTakeFirst spy lets each test control the org_settings row (or throw).
 */
const mkDb = (executeTakeFirst: () => Promise<unknown>) => {
  const chain = {
    select: () => chain,
    where: () => chain,
    executeTakeFirst,
  };
  return { selectFrom: () => chain } as never;
};

describe('createSandboxAllowListReader', () => {
  it('returns the safe deny-all default when no DB handle is supplied', async () => {
    const reader = createSandboxAllowListReader({});
    expect(await reader.read('org-1')).toEqual({ capabilities: [], allowHostNetwork: false });
  });

  it('reads and canonicalizes the configured allow-list', async () => {
    const reader = createSandboxAllowListReader({
      db: mkDb(async () => ({
        sandbox_allowed_capabilities: ['CAP_NET_ADMIN', 'sys_admin'],
        sandbox_allow_host_network: true,
      })),
    });
    expect(await reader.read('org-2')).toEqual({
      capabilities: ['NET_ADMIN', 'SYS_ADMIN'],
      allowHostNetwork: true,
    });
  });

  it('defaults an unset row to deny-all', async () => {
    const reader = createSandboxAllowListReader({
      db: mkDb(async () => undefined),
    });
    expect(await reader.read('org-3')).toEqual({ capabilities: [], allowHostNetwork: false });
  });

  it('treats null columns as deny-all', async () => {
    const reader = createSandboxAllowListReader({
      db: mkDb(async () => ({
        sandbox_allowed_capabilities: null,
        sandbox_allow_host_network: null,
      })),
    });
    expect(await reader.read('org-4')).toEqual({ capabilities: [], allowHostNetwork: false });
  });

  it('degrades to deny-all on a DB error (fail-safe)', async () => {
    const reader = createSandboxAllowListReader({
      db: mkDb(async () => {
        throw new Error('db down');
      }),
    });
    expect(await reader.read('org-5')).toEqual({ capabilities: [], allowHostNetwork: false });
  });
});

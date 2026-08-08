import { describe, it, expect, vi, beforeEach } from 'vitest';

// Isolated in its own file: mocking `node:module` at the top level replaces
// `register` for the whole file, which would break the FS-based `.ts`-loading
// tests in workflow-loader.test.ts that rely on the real loader hook.
const registerMock = vi.fn();
vi.mock('node:module', async (orig) => {
  const actual = await orig<typeof import('node:module')>();
  return { ...actual, register: registerMock };
});

describe('ensureLoaderHookRegistered (path-aware)', () => {
  beforeEach(() => {
    registerMock.mockReset();
  });

  it('registers the on-disk file:// hook when KICI_TS_LOADER_HOOK_PATH is set', async () => {
    vi.resetModules();
    process.env.KICI_TS_LOADER_HOOK_PATH = '/opt/kici/ts-loader-hook.js';
    const { ensureLoaderHookRegistered } = await import('./workflow-loader.ts');
    ensureLoaderHookRegistered();
    expect(registerMock).toHaveBeenCalledWith(
      'file:///opt/kici/ts-loader-hook.js',
      expect.any(String),
    );
    delete process.env.KICI_TS_LOADER_HOOK_PATH;
  });

  it('registers the bare @kici-dev/core specifier when the env var is unset', async () => {
    vi.resetModules();
    delete process.env.KICI_TS_LOADER_HOOK_PATH;
    const { ensureLoaderHookRegistered } = await import('./workflow-loader.ts');
    ensureLoaderHookRegistered();
    expect(registerMock).toHaveBeenCalledWith('@kici-dev/core/ts-loader-hook', expect.any(String));
  });
});

import { describe, it, expect, vi } from 'vitest';

const registerSpy = vi.fn();
vi.mock('node:module', () => ({ register: registerSpy }));

describe('ensureTsLoaderHook', () => {
  it('registers the core ts-loader hook exactly once across calls', async () => {
    const { ensureTsLoaderHook } = await import('./ts-loader.js');
    ensureTsLoaderHook();
    ensureTsLoaderHook();
    ensureTsLoaderHook();
    expect(registerSpy).toHaveBeenCalledTimes(1);
    expect(registerSpy).toHaveBeenCalledWith('@kici-dev/core/ts-loader-hook', expect.anything());
  });
});

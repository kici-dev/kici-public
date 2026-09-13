import { describe, it, expect } from 'vitest';
import { onCancel, cleanup, onSuccess, onFailure, beforeStep, afterStep } from './index.js';
import type { HookConfig, HookFn, HookContext } from './types.js';

const mockHookFn: HookFn = async (_ctx: HookContext) => {};

describe('SDK hook factory functions', () => {
  describe('onCancel', () => {
    it('creates HookConfig from bare function', () => {
      const config = onCancel(mockHookFn);
      expect(config.type).toBe('onCancel');
      expect(config.name).toBe('onCancel');
      expect(config.run).toBe(mockHookFn);
      expect(config.timeout).toBeUndefined();
    });

    it('creates HookConfig from object with timeout', () => {
      const config = onCancel({ run: mockHookFn, timeout: 30_000 });
      expect(config.type).toBe('onCancel');
      expect(config.run).toBe(mockHookFn);
      expect(config.timeout).toBe(30_000);
    });
  });

  describe('cleanup', () => {
    it('creates HookConfig with type cleanup', () => {
      const config = cleanup(mockHookFn);
      expect(config.type).toBe('cleanup');
      expect(config.name).toBe('cleanup');
      expect(config.run).toBe(mockHookFn);
    });
  });

  describe('onSuccess', () => {
    it('creates HookConfig with type onSuccess', () => {
      const config = onSuccess(mockHookFn);
      expect(config.type).toBe('onSuccess');
      expect(config.name).toBe('onSuccess');
    });
  });

  describe('onFailure', () => {
    it('creates HookConfig with type onFailure', () => {
      const config = onFailure(mockHookFn);
      expect(config.type).toBe('onFailure');
      expect(config.name).toBe('onFailure');
    });
  });

  describe('beforeStep', () => {
    it('creates HookConfig with type beforeStep', () => {
      const config = beforeStep(mockHookFn);
      expect(config.type).toBe('beforeStep');
      expect(config.name).toBe('beforeStep');
    });
  });

  describe('afterStep', () => {
    it('creates HookConfig with type afterStep', () => {
      const config = afterStep(mockHookFn);
      expect(config.type).toBe('afterStep');
      expect(config.name).toBe('afterStep');
    });
  });

  it('all factories return proper HookConfig shape', () => {
    const factories = [onCancel, cleanup, onSuccess, onFailure, beforeStep, afterStep] as const;
    for (const factory of factories) {
      const config: HookConfig = factory(mockHookFn);
      expect(config).toHaveProperty('name');
      expect(config).toHaveProperty('type');
      expect(config).toHaveProperty('run');
      expect(typeof config.run).toBe('function');
    }
  });
});

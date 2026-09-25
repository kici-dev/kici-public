import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockWarn = vi.hoisted(() => vi.fn());
vi.mock('@kici-dev/shared', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@kici-dev/shared')>();
  return {
    ...actual,
    createLogger: () => ({ info: vi.fn(), warn: mockWarn, error: vi.fn(), debug: vi.fn() }),
  };
});

import { deriveKey } from '@kici-dev/shared';
import {
  configureJobSecretSealing,
  JobSecretsUnsealError,
  sealJobConfig,
  unsealJobConfig,
} from './job-secret-seal.js';

const KEYS = {
  material: 'a'.repeat(64),
  materialOld: undefined,
  current: deriveKey('a'.repeat(64)),
  old: undefined,
};

describe('job secret sealing', () => {
  beforeEach(() => mockWarn.mockClear());

  it('warns once, naming the setting, when no master key is configured', () => {
    configureJobSecretSealing(null);
    // fails-when: an orchestrator stores job secrets unencrypted without saying so
    expect(mockWarn).toHaveBeenCalledTimes(1);
    expect(mockWarn.mock.calls[0][0]).toContain('KICI_SECRET_KEY');
    // breaks-if-wrong: a configured master key logs nothing
    configureJobSecretSealing(KEYS);
    expect(mockWarn).toHaveBeenCalledTimes(1);
  });

  it('leaves a config with no secret field untouched and unsealed', () => {
    configureJobSecretSealing(KEYS);
    const config = { name: 'build', steps: [] };
    expect(sealJobConfig('run-1', config)).toEqual({ jobConfig: config, sealed: null });
  });

  it('binds a seal to its run: another run id cannot open it', () => {
    configureJobSecretSealing(KEYS);
    const { jobConfig, sealed } = sealJobConfig('run-1', { name: 'b', secrets: { A: 'x' } });
    expect(jobConfig).toEqual({ name: 'b' });
    expect(unsealJobConfig('run-1', jobConfig, sealed)).toEqual({ name: 'b', secrets: { A: 'x' } });
    // fails-when: a sealed value copied onto another run's row opens there
    expect(() => unsealJobConfig('run-2', jobConfig, sealed)).toThrow(JobSecretsUnsealError);
  });
});

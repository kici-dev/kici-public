import { describe, it, expect, vi } from 'vitest';

const { warn, info } = vi.hoisted(() => ({ warn: vi.fn(), info: vi.fn() }));
vi.mock('@kici-dev/shared', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@kici-dev/shared')>();
  return {
    ...actual,
    createLogger: vi.fn(() => ({ warn, info, error: vi.fn(), debug: vi.fn() })),
  };
});

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  checkoutJobConfigFields,
  jobConfigForAgent,
  MIN_CHECKOUT_SKIP_AGENT_VERSION,
} from './checkout-job-config.js';

describe('checkoutJobConfigFields', () => {
  it('forwards checkout: false', () =>
    expect(checkoutJobConfigFields({ name: 'j', checkout: false })).toEqual({ checkout: false }));

  it('forwards checkout: true', () =>
    expect(checkoutJobConfigFields({ name: 'j', checkout: true })).toEqual({ checkout: true }));

  it('forwards valid options', () =>
    expect(checkoutJobConfigFields({ name: 'j', checkoutOptions: { fetchDepth: 0 } })).toEqual({
      checkoutOptions: { fetchDepth: 0 },
    }));

  it('drops a non-boolean checkout and invalid options', () => {
    warn.mockClear();
    // fails-when: unvalidated generator JSON reaches the agent's clone argv
    expect(
      checkoutJobConfigFields({ name: 'j', checkout: 'no', checkoutOptions: { fetchDepth: -3 } }),
    ).toEqual({});
    expect(warn).toHaveBeenCalledWith('Dropping an invalid checkoutOptions from a job', {
      jobName: 'j',
    });
  });

  it('carries nothing when the lock job has neither key', () => {
    warn.mockClear();
    expect(checkoutJobConfigFields({ name: 'j' })).toEqual({});
    // breaks-if-wrong: an absent key is the default checkout, not an invalid one
    expect(warn).not.toHaveBeenCalled();
  });
});

describe('jobConfigForAgent', () => {
  const skip = { name: 'deploy', checkout: false, checkoutOptions: { fetchDepth: 5 } };
  const agent = (version: string | null) => ({ agentId: 'agent-1', version });

  it('pins the first agent release that runs a checkout: false job', () =>
    expect(MIN_CHECKOUT_SKIP_AGENT_VERSION).toBe('0.29.0'));

  it.each(['0.28.0', '0.28.9-10536', '0.5.0'])(
    'drops checkout: false for an agent at %s, keeping every other key',
    (version) => {
      info.mockClear();
      // fails-when: the gate is gone, so an agent that cannot load the workflow without a clone skips it
      expect(jobConfigForAgent(skip, agent(version), 'job-1')).toEqual({
        name: 'deploy',
        checkoutOptions: { fetchDepth: 5 },
      });
      expect(info).toHaveBeenCalledWith(
        'Agent is too old to skip the clone; the checkout: false job clones instead',
        { jobId: 'job-1', agentId: 'agent-1', agentVersion: version, minimumVersion: '0.29.0' },
      );
    },
  );

  it.each([null, '', 'dev'])('drops checkout: false for an agent whose version is %j', (version) =>
    // fails-when: an unknown version reads as new enough, as in agentVersionAtLeast's "cannot tell" rule
    expect(jobConfigForAgent(skip, agent(version), 'job-1')).not.toHaveProperty('checkout'),
  );

  it.each(['0.29.0', '0.29.0-10600', '0.30.1', '1.0.0'])(
    'keeps checkout: false for an agent at %s',
    (version) => {
      info.mockClear();
      // breaks-if-wrong: a current agent must still skip the clone
      expect(jobConfigForAgent(skip, agent(version), 'job-1')).toBe(skip);
      expect(info).not.toHaveBeenCalled();
    },
  );

  it('leaves a cloning job untouched for an old agent and never mutates the input', () => {
    const clone = { name: 'build', checkout: true };
    expect(jobConfigForAgent(clone, agent('0.28.0'), 'job-1')).toBe(clone);
    jobConfigForAgent(skip, agent('0.28.0'), 'job-1');
    expect(skip.checkout).toBe(false);
  });

  it('is applied at the coordinator send site to the receiving agent', () => {
    const core = readFileSync(
      fileURLToPath(new URL('../orchestrator-core.ts', import.meta.url)),
      'utf-8',
    );
    // fails-when: the coordinator builds the agent's jobConfig without the per-agent gate
    expect(core).toMatch(
      /const cleanJobConfig = jobConfigForAgent\([\s\S]{0,600}?\),\s*entry,\s*job\.id,\s*\);/,
    );
  });
});

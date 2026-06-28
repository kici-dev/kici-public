import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { schedule } from './index.js';
import { defineDispatchInputs } from './dispatch-inputs.js';

describe('schedule()', () => {
  it('creates frozen config with correct _tag', () => {
    const trigger = schedule({ cron: '0 * * * *' });
    expect(trigger._tag).toBe('ScheduleTrigger');
    expect(trigger.cron).toBe('0 * * * *');
    expect(Object.isFrozen(trigger)).toBe(true);
  });

  it('defaults timezone to UTC', () => {
    const trigger = schedule({ cron: '0 0 * * *' });
    expect(trigger.timezone).toBe('UTC');
  });

  it('accepts explicit timezone', () => {
    const trigger = schedule({ cron: '0 9 * * 1', timezone: 'America/New_York' });
    expect(trigger.timezone).toBe('America/New_York');
  });

  it('supports optional description', () => {
    const trigger = schedule({ cron: '0 0 * * *', description: 'Nightly build' });
    expect(trigger.description).toBe('Nightly build');
  });

  it('omits undefined optional fields', () => {
    const trigger = schedule({ cron: '0 0 * * *' });
    expect('description' in trigger).toBe(false);
  });

  it('throws on empty cron string', () => {
    expect(() => schedule({ cron: '' })).toThrow('non-empty cron expression');
  });

  it('throws on whitespace-only cron string', () => {
    expect(() => schedule({ cron: '   ' })).toThrow('non-empty cron expression');
  });

  it('produces correct full config', () => {
    const trigger = schedule({
      cron: '0 * * * *',
      timezone: 'Europe/Berlin',
      description: 'Hourly check',
    });
    expect(trigger).toEqual({
      _tag: 'ScheduleTrigger',
      cron: '0 * * * *',
      timezone: 'Europe/Berlin',
      description: 'Hourly check',
    });
  });
});

describe('schedule({ inputs })', () => {
  it('carries an inputs map on the frozen config', () => {
    const t = schedule({
      cron: '0 0 * * *',
      inputs: { mode: z.enum(['full', 'quick']).default('full') },
    });
    expect(t.inputs?.mode).toBeDefined();
    expect(Object.isFrozen(t)).toBe(true);
  });

  it('omits inputs when not declared', () => {
    expect(schedule({ cron: '0 0 * * *' }).inputs).toBeUndefined();
  });

  it('unwraps a defineDispatchInputs handle to its map', () => {
    const handle = defineDispatchInputs({ mode: z.enum(['full', 'quick']).default('full') });
    const t = schedule({ cron: '0 0 * * *', inputs: handle });
    expect(t.inputs?.mode).toBeDefined();
  });
});

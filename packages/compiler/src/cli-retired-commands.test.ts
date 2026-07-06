import { describe, it, expect } from 'vitest';
import { Command } from 'commander';
import { RETIRED_COMMANDS, retiredCommandHint, attemptedCommand } from './cli.js';

describe('retiredCommandHint', () => {
  it('names kici runs and kici diagnostics for the retired status command', () => {
    const hint = retiredCommandHint('status');
    expect(hint).toBeDefined();
    expect(hint).toContain('kici runs');
    expect(hint).toContain('kici diagnostics');
  });

  it('names kici runs cancel for the retired cancel command', () => {
    const hint = retiredCommandHint('cancel');
    expect(hint).toBeDefined();
    expect(hint).toContain('kici runs cancel');
  });

  it('returns undefined for an unknown command name', () => {
    expect(retiredCommandHint('bogus')).toBeUndefined();
  });

  it('returns undefined when no command name is given', () => {
    expect(retiredCommandHint(undefined)).toBeUndefined();
  });

  it('seeds status and cancel in the retired-command map', () => {
    expect(Object.keys(RETIRED_COMMANDS).sort()).toEqual(['cancel', 'status']);
  });
});

describe('attemptedCommand', () => {
  it('returns the first non-option token from raw argv when no operand is parsed', () => {
    expect(attemptedCommand(new Command(), ['node', 'kici', 'status', '--json'])).toBe('status');
  });

  it('skips leading options and returns the first bare token', () => {
    expect(attemptedCommand(new Command(), ['node', 'kici', '--verbose', 'cancel'])).toBe('cancel');
  });

  it('returns undefined when argv carries only options', () => {
    expect(attemptedCommand(new Command(), ['node', 'kici', '--json'])).toBeUndefined();
  });
});

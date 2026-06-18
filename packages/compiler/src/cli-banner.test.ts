import { describe, it, expect } from 'vitest';
import { Command } from 'commander';
import { shouldSuppressBanner } from './cli-banner.js';

function makeCommand(opts: Record<string, unknown>): Command {
  const cmd = new Command('status');
  cmd.option('--json');
  cmd.option('--quiet');
  for (const [key, value] of Object.entries(opts)) {
    cmd.setOptionValue(key, value);
  }
  return cmd;
}

describe('shouldSuppressBanner', () => {
  it('suppresses when --json is set', () => {
    expect(shouldSuppressBanner(makeCommand({ json: true }))).toBe(true);
  });

  it('suppresses when --quiet is set', () => {
    expect(shouldSuppressBanner(makeCommand({ quiet: true }))).toBe(true);
  });

  it('suppresses when both --json and --quiet are set', () => {
    expect(shouldSuppressBanner(makeCommand({ json: true, quiet: true }))).toBe(true);
  });

  it('does not suppress when neither flag is set', () => {
    expect(shouldSuppressBanner(makeCommand({}))).toBe(false);
  });

  it('does not suppress when flags are explicitly false', () => {
    expect(shouldSuppressBanner(makeCommand({ json: false, quiet: false }))).toBe(false);
  });
});

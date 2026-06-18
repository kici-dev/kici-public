import { describe, it, expect } from 'vitest';
import { rule, skip } from './rule.js';
import type { RuleContext } from './types.js';

describe('rule()', () => {
  it('creates a rule with _tag: Rule', () => {
    const r = rule('test rule');
    expect(r._tag).toBe('Rule');
  });

  it('stores the label correctly', () => {
    const r = rule('my custom label');
    expect(r.label).toBe('my custom label');
  });

  it('without check function defaults to always-true', async () => {
    const r = rule('marker only');
    const mockContext = {} as RuleContext;
    expect(await r.check(mockContext)).toBe(true);
  });

  it('with check function stores the check function', () => {
    const checkFn = () => false;
    const r = rule('has check', checkFn);
    expect(r.check).toBe(checkFn);
  });

  it('check function can be sync (returns boolean)', () => {
    const r = rule('sync check', () => false);
    const mockContext = {} as RuleContext;
    // Sync function returns boolean directly
    const result = r.check(mockContext);
    expect(result).toBe(false);
  });

  it('check function can be async (returns Promise<boolean>)', async () => {
    const r = rule('async check', async () => {
      await Promise.resolve();
      return true;
    });
    const mockContext = {} as RuleContext;
    const result = await r.check(mockContext);
    expect(result).toBe(true);
  });

  it('check function receives RuleContext', async () => {
    let receivedContext: RuleContext | undefined;

    const r = rule('context test', (ctx) => {
      receivedContext = ctx;
      return true;
    });

    const mockContext: RuleContext = {
      event: { type: 'push' },
      changedFiles: ['src/main.ts', 'README.md'],
      env: { CI: 'true' },
      $: {} as RuleContext['$'],
    };

    await r.check(mockContext);

    expect(receivedContext).toBe(mockContext);
    expect(receivedContext?.event.type).toBe('push');
    expect(receivedContext?.changedFiles).toEqual(['src/main.ts', 'README.md']);
    expect(receivedContext?.env.CI).toBe('true');
  });
});

describe('skip()', () => {
  it('creates rule with _tag: Rule', () => {
    const s = skip('skip rule', () => true);
    expect(s._tag).toBe('Rule');
  });

  it('stores the label correctly', () => {
    const s = skip('skip when docs only', () => true);
    expect(s.label).toBe('skip when docs only');
  });

  it('returns false when check returns true (skips when condition met)', async () => {
    // Condition: all files are markdown
    const s = skip('docs only PR', (ctx) => {
      return ctx.changedFiles.every((f) => f.endsWith('.md'));
    });

    const mockContext: RuleContext = {
      event: { type: 'pull_request' },
      changedFiles: ['README.md', 'docs/guide.md'],
      env: {},
      $: {} as RuleContext['$'],
    };

    // Condition is true (all files are .md), so rule returns false (skip)
    const result = await s.check(mockContext);
    expect(result).toBe(false);
  });

  it('returns true when check returns false (runs when condition not met)', async () => {
    // Condition: all files are markdown
    const s = skip('docs only PR', (ctx) => {
      return ctx.changedFiles.every((f) => f.endsWith('.md'));
    });

    const mockContext: RuleContext = {
      event: { type: 'pull_request' },
      changedFiles: ['README.md', 'src/main.ts'], // Has non-md file
      env: {},
      $: {} as RuleContext['$'],
    };

    // Condition is false (not all files are .md), so rule returns true (run)
    const result = await s.check(mockContext);
    expect(result).toBe(true);
  });

  it('works with async check functions', async () => {
    const s = skip('async skip', async (ctx) => {
      await Promise.resolve();
      return ctx.changedFiles.length === 0;
    });

    const emptyContext: RuleContext = {
      event: { type: 'push' },
      changedFiles: [],
      env: {},
      $: {} as RuleContext['$'],
    };

    const nonEmptyContext: RuleContext = {
      event: { type: 'push' },
      changedFiles: ['file.ts'],
      env: {},
      $: {} as RuleContext['$'],
    };

    // Empty files -> condition true -> skip (false)
    expect(await s.check(emptyContext)).toBe(false);
    // Has files -> condition false -> run (true)
    expect(await s.check(nonEmptyContext)).toBe(true);
  });
});

import { describe, it, expect } from 'vitest';
import { fixture } from './fixture.js';
import type { FixtureOptions } from './fixture.js';
import type { PushTriggerConfig, PrTriggerConfig } from './triggers/types.js';

describe('fixture()', () => {
  it('creates object with id and options', () => {
    const options: FixtureOptions = {
      event: { type: 'push', branches: ['main'] } as PushTriggerConfig,
    };
    const f = fixture('push-main', options);
    expect(f.id).toBe('push-main');
    expect(f.options).toEqual(options);
  });

  it('returned object is frozen', () => {
    const options: FixtureOptions = {
      event: { type: 'push', branches: ['main'] } as PushTriggerConfig,
    };
    const f = fixture('push-main', options);
    expect(Object.isFrozen(f)).toBe(true);
  });

  it('options object is frozen when plain object', () => {
    const options: FixtureOptions = {
      event: { type: 'push', branches: ['main'] } as PushTriggerConfig,
    };
    const f = fixture('push-main', options);
    expect(Object.isFrozen(f.options)).toBe(true);
  });

  it('event can be a PushTriggerConfig', () => {
    const event: PushTriggerConfig = { type: 'push', branches: ['main', 'develop'] };
    const f = fixture('push-multi', { event });
    expect((f.options as FixtureOptions).event).toEqual(event);
  });

  it('event can be a PrTriggerConfig', () => {
    const event: PrTriggerConfig = { type: 'pr', events: ['opened'] };
    const f = fixture('pr-open', { event });
    expect((f.options as FixtureOptions).event).toEqual(event);
  });

  it('rejects empty string ID', () => {
    expect(() =>
      fixture('', { event: { type: 'push', branches: ['main'] } as PushTriggerConfig }),
    ).toThrow('Fixture ID must be a non-empty string');
  });

  it('rejects ID with spaces', () => {
    expect(() =>
      fixture('push main', { event: { type: 'push', branches: ['main'] } as PushTriggerConfig }),
    ).toThrow('Fixture ID must not contain whitespace');
  });

  it('rejects ID with tabs', () => {
    expect(() =>
      fixture('push\tmain', { event: { type: 'push', branches: ['main'] } as PushTriggerConfig }),
    ).toThrow('Fixture ID must not contain whitespace');
  });

  it('rejects ID with newlines', () => {
    expect(() =>
      fixture('push\nmain', { event: { type: 'push', branches: ['main'] } as PushTriggerConfig }),
    ).toThrow('Fixture ID must not contain whitespace');
  });

  it('accepts async factory function as options', () => {
    const factory = async () => ({
      event: { type: 'push', branches: ['main'] } as PushTriggerConfig,
    });
    const f = fixture('push-async', factory);
    expect(f.id).toBe('push-async');
    expect(typeof f.options).toBe('function');
    expect(Object.isFrozen(f)).toBe(true);
  });

  it('accepts sync factory function as options', () => {
    const factory = () => ({
      event: { type: 'push', branches: ['main'] } as PushTriggerConfig,
    });
    const f = fixture('push-sync', factory);
    expect(f.id).toBe('push-sync');
    expect(typeof f.options).toBe('function');
  });

  it('optional branch field works correctly', () => {
    const f = fixture('push-branch', {
      event: { type: 'push', branches: ['main'] } as PushTriggerConfig,
      branch: 'feature/auth',
    });
    expect((f.options as FixtureOptions).branch).toBe('feature/auth');
  });

  it('optional sha field works correctly', () => {
    const f = fixture('push-sha', {
      event: { type: 'push', branches: ['main'] } as PushTriggerConfig,
      sha: 'abc123def456',
    });
    expect((f.options as FixtureOptions).sha).toBe('abc123def456');
  });

  it('optional repo field works correctly', () => {
    const f = fixture('push-repo', {
      event: { type: 'push', branches: ['main'] } as PushTriggerConfig,
      repo: 'owner/repo',
    });
    expect((f.options as FixtureOptions).repo).toBe('owner/repo');
  });

  it('optional pr field works correctly', () => {
    const f = fixture('pr-42', {
      event: { type: 'pr', events: ['opened'] } as PrTriggerConfig,
      pr: 42,
    });
    expect((f.options as FixtureOptions).pr).toBe(42);
  });

  it('optional secrets field works correctly', () => {
    const f = fixture('push-secrets', {
      event: { type: 'push', branches: ['main'] } as PushTriggerConfig,
      secrets: { db: 'test-database', api: 'test-api-key' },
    });
    expect((f.options as FixtureOptions).secrets).toEqual({
      db: 'test-database',
      api: 'test-api-key',
    });
  });

  it('optional workflowName field works correctly', () => {
    const f = fixture('direct-run', {
      event: { type: 'push', branches: ['main'] } as PushTriggerConfig,
      workflowName: 'ci',
    });
    expect((f.options as FixtureOptions).workflowName).toBe('ci');
  });

  it('all optional fields together', () => {
    const f = fixture('full-fixture', {
      event: { type: 'pr', events: ['opened'] } as PrTriggerConfig,
      branch: 'feature/test',
      sha: 'deadbeef',
      repo: 'org/repo',
      pr: 99,
      secrets: { token: 'test-token' },
      workflowName: 'ci-full',
    });
    const opts = f.options as FixtureOptions;
    expect(opts.branch).toBe('feature/test');
    expect(opts.sha).toBe('deadbeef');
    expect(opts.repo).toBe('org/repo');
    expect(opts.pr).toBe(99);
    expect(opts.secrets).toEqual({ token: 'test-token' });
    expect(opts.workflowName).toBe('ci-full');
  });
});

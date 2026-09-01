import { describe, it, expect } from 'vitest';
import { GrantTable } from './grant-table.js';

const T0 = 1_700_000_000_000;

describe('GrantTable', () => {
  it('serves a grant for its own repo path only', () => {
    const t = new GrantTable();
    t.add({
      repoPath: 'kici-dev/tester',
      permissions: { contents: 'write' },
      expiresAt: T0 + 60_000,
    });
    expect(t.lookup('kici-dev/tester', T0)).toMatchObject({ permissions: { contents: 'write' } });
    expect(t.lookup('cmaster11/main', T0)).toBeNull();
  });

  it('normalises a .git suffix and a leading slash so git path forms match', () => {
    const t = new GrantTable();
    t.add({
      repoPath: 'kici-dev/tester',
      permissions: { contents: 'write' },
      expiresAt: T0 + 60_000,
    });
    expect(t.lookup('/kici-dev/tester.git', T0)).not.toBeNull();
  });

  it('stops serving after revoke', () => {
    const t = new GrantTable();
    const id = t.add({
      repoPath: 'a/b',
      permissions: { contents: 'write' },
      expiresAt: T0 + 60_000,
    });
    t.revoke(id);
    expect(t.lookup('a/b', T0)).toBeNull();
  });

  it('expires by TTL so a crashed step cannot leave a standing grant', () => {
    const t = new GrantTable();
    t.add({ repoPath: 'a/b', permissions: { contents: 'write' }, expiresAt: T0 + 1_000 });
    expect(t.lookup('a/b', T0)).not.toBeNull();
    expect(t.lookup('a/b', T0 + 1_001)).toBeNull();
    expect(t.size(T0 + 1_001)).toBe(0);
  });

  it('keeps concurrent grants for different repos independent', () => {
    const t = new GrantTable();
    const a = t.add({
      repoPath: 'a/one',
      permissions: { contents: 'write' },
      expiresAt: T0 + 60_000,
    });
    t.add({ repoPath: 'b/two', permissions: { contents: 'write' }, expiresAt: T0 + 60_000 });
    t.revoke(a);
    expect(t.lookup('a/one', T0)).toBeNull();
    expect(t.lookup('b/two', T0)).not.toBeNull();
  });

  it('revoking an unknown id is a no-op, so a double revoke is safe', () => {
    const t = new GrantTable();
    t.add({ repoPath: 'a/b', permissions: { contents: 'write' }, expiresAt: T0 + 60_000 });
    expect(() => t.revoke('not-a-real-id')).not.toThrow();
    expect(t.lookup('a/b', T0)).not.toBeNull();
  });
});

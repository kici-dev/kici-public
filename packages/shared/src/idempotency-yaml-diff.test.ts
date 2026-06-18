import { describe, expect, it } from 'vitest';
import {
  diffYamlContent,
  isPathSensitive,
  renderYamlDiff,
  type YamlDiffEntry,
} from './idempotency-yaml-diff.js';

describe('isPathSensitive', () => {
  it('matches password / passwd', () => {
    expect(isPathSensitive('db.password')).toBe(true);
    expect(isPathSensitive('Database.Postgres.User.Passwd')).toBe(true);
  });

  it('matches secret / secrets / token / credentials', () => {
    expect(isPathSensitive('auth.secret')).toBe(true);
    expect(isPathSensitive('vault.secrets')).toBe(true);
    expect(isPathSensitive('keycloak.serviceToken')).toBe(false); // not a whole segment
    expect(isPathSensitive('keycloak.service.token')).toBe(true);
    expect(isPathSensitive('aws.credentials')).toBe(true);
    expect(isPathSensitive('client.credential')).toBe(true);
  });

  it('matches api_key / api-key / apikey', () => {
    expect(isPathSensitive('config.api_key')).toBe(true);
    expect(isPathSensitive('config.api-key')).toBe(true);
    expect(isPathSensitive('config.apikey')).toBe(true);
  });

  it('treats numeric array indices as non-sensitive segments', () => {
    expect(isPathSensitive('clients[0].name')).toBe(false);
    expect(isPathSensitive('clients[0].token')).toBe(true);
  });

  it('returns false for non-sensitive paths', () => {
    expect(isPathSensitive('server.port')).toBe(false);
    expect(isPathSensitive('features.beta')).toBe(false);
    expect(isPathSensitive('hostname')).toBe(false);
  });

  it('is case-insensitive', () => {
    expect(isPathSensitive('DB.PASSWORD')).toBe(true);
    expect(isPathSensitive('cfg.Secret')).toBe(true);
  });
});

describe('diffYamlContent', () => {
  it('returns an empty array for byte-identical inputs', () => {
    const yaml = 'server:\n  port: 80\n  host: localhost\n';
    expect(diffYamlContent(yaml, yaml)).toEqual([]);
  });

  it('returns an empty array for whitespace-different but structurally equal inputs', () => {
    const local = 'server:\n  port: 80\n  host: localhost\n';
    const remote = 'server: {port: 80, host: localhost}\n';
    expect(diffYamlContent(local, remote)).toEqual([]);
  });

  it('classifies a scalar change with dotted path', () => {
    const local = 'server:\n  port: 8080\n';
    const remote = 'server:\n  port: 80\n';
    const out = diffYamlContent(local, remote);
    expect(out).toEqual([
      {
        path: 'server.port',
        kind: 'changed',
        oldValue: 80,
        newValue: 8080,
        sensitive: false,
      },
    ]);
  });

  it('classifies an added scalar', () => {
    const local = 'server:\n  port: 80\n  host: localhost\n';
    const remote = 'server:\n  port: 80\n';
    const out = diffYamlContent(local, remote);
    expect(out).toHaveLength(1);
    expect(out[0]).toEqual({
      path: 'server.host',
      kind: 'added',
      newValue: 'localhost',
      sensitive: false,
    });
  });

  it('classifies a removed scalar', () => {
    const local = 'server:\n  port: 80\n';
    const remote = 'server:\n  port: 80\n  legacy: true\n';
    const out = diffYamlContent(local, remote);
    expect(out).toHaveLength(1);
    expect(out[0]).toEqual({
      path: 'server.legacy',
      kind: 'removed',
      oldValue: true,
      sensitive: false,
    });
  });

  it('walks arrays element-by-element', () => {
    const local = 'clients:\n  - name: alpha\n  - name: beta\n  - name: gamma\n';
    const remote = 'clients:\n  - name: alpha\n  - name: BETA\n';
    const out = diffYamlContent(local, remote);
    // One changed name + one added array element. The added entry is
    // emitted at the array-index path (subtree collapse) rather than the
    // descendant leaf — see `emitLeafOrTree`'s jsdoc.
    const paths = out.map((e) => `${e.kind}:${e.path}`).sort();
    expect(paths).toEqual(['added:clients[2]', 'changed:clients[1].name']);
  });

  it('marks sensitive paths via the keyword heuristic', () => {
    const local = 'database:\n  postgres:\n    password: tr0ub4dor\n';
    const remote = 'database:\n  postgres:\n    password: hunter2\n';
    const out = diffYamlContent(local, remote);
    expect(out).toHaveLength(1);
    expect(out[0]?.path).toBe('database.postgres.password');
    expect(out[0]?.sensitive).toBe(true);
  });

  it('handles a shape mismatch (object → scalar) as a changed leaf', () => {
    const local = 'server: 80\n';
    const remote = 'server:\n  port: 80\n';
    const out = diffYamlContent(local, remote);
    expect(out).toHaveLength(1);
    expect(out[0]?.kind).toBe('changed');
    expect(out[0]?.path).toBe('server');
  });

  it('treats an empty input as null tree (whole-document add/remove)', () => {
    const local = 'server: {port: 80}\n';
    const remote = '';
    const out = diffYamlContent(local, remote);
    expect(out).toHaveLength(1);
    expect(out[0]?.kind).toBe('added');
    expect(out[0]?.path).toBe('<root>');
  });
});

describe('renderYamlDiff (masked default)', () => {
  it('masks sensitive entries inline', () => {
    const entries: YamlDiffEntry[] = [
      {
        path: 'database.postgres.password',
        kind: 'changed',
        oldValue: 'hunter2',
        newValue: 'tr0ub4dor',
        sensitive: true,
      },
    ];
    const lines = renderYamlDiff(entries);
    const joined = lines.join('\n');
    expect(joined).toContain('database.postgres.password: changed');
    expect(joined).toContain('masked');
    // Mask invariant: no plaintext value appears in the default render.
    expect(joined).not.toContain('hunter2');
    expect(joined).not.toContain('tr0ub4dor');
  });

  it('reveals non-sensitive entries inline', () => {
    const entries: YamlDiffEntry[] = [
      {
        path: 'server.port',
        kind: 'changed',
        oldValue: 80,
        newValue: 8080,
        sensitive: false,
      },
    ];
    const lines = renderYamlDiff(entries);
    const joined = lines.join('\n');
    expect(joined).toContain('server.port: changed');
    expect(joined).toContain('- old=80');
    expect(joined).toContain('+ new=8080');
  });

  it('shows fallback line on empty input', () => {
    expect(renderYamlDiff([])).toEqual(['0 yaml leaf(s) drifted (structure matches)']);
  });
});

describe('renderYamlDiff (reveal: true)', () => {
  it('shows sensitive values when explicitly revealed', () => {
    const entries: YamlDiffEntry[] = [
      {
        path: 'auth.token',
        kind: 'changed',
        oldValue: 'old-token-xxx',
        newValue: 'new-token-yyy',
        sensitive: true,
      },
    ];
    const lines = renderYamlDiff(entries, { reveal: true });
    const joined = lines.join('\n');
    expect(joined).toContain('old-token-xxx');
    expect(joined).toContain('new-token-yyy');
    expect(joined).not.toContain('masked');
  });
});

describe('renderYamlDiff (color)', () => {
  it('emits ANSI escapes around the kind label when color=true', () => {
    const entries: YamlDiffEntry[] = [
      { path: 'a', kind: 'added', newValue: 1, sensitive: false },
      { path: 'b', kind: 'changed', oldValue: 1, newValue: 2, sensitive: false },
    ];
    const lines = renderYamlDiff(entries, { color: true });
    expect(/\x1b\[/.test(lines.join('\n'))).toBe(true);
  });
});

describe('value formatting', () => {
  it('renders objects as compact JSON', () => {
    const entries: YamlDiffEntry[] = [
      {
        path: 'config',
        kind: 'added',
        newValue: { a: 1, b: [2, 3] },
        sensitive: false,
      },
    ];
    const lines = renderYamlDiff(entries);
    expect(lines.join('\n')).toContain('+ new={"a":1,"b":[2,3]}');
  });

  it('truncates large object values', () => {
    const big: Record<string, string> = {};
    for (let i = 0; i < 100; i++) big[`key${i}`] = 'v'.repeat(50);
    const entries: YamlDiffEntry[] = [
      { path: 'config', kind: 'added', newValue: big, sensitive: false },
    ];
    const lines = renderYamlDiff(entries);
    const joined = lines.join('\n');
    expect(joined).toContain('more bytes');
  });
});

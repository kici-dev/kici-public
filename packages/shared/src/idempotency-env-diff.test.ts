import { describe, expect, it } from 'vitest';
import {
  diffEnvFiles,
  parseEnvLines,
  renderEnvDiff,
  type EnvDiffEntry,
} from './idempotency-env-diff.js';

describe('parseEnvLines', () => {
  it('parses KEY=value pairs', () => {
    const m = parseEnvLines('FOO=bar\nBAZ=qux\n');
    expect(m.get('FOO')).toBe('bar');
    expect(m.get('BAZ')).toBe('qux');
    expect(m.size).toBe(2);
  });

  it('skips blank lines', () => {
    const m = parseEnvLines('FOO=bar\n\n   \nBAZ=qux\n');
    expect(m.size).toBe(2);
  });

  it('skips comment lines (#-prefixed)', () => {
    const m = parseEnvLines('# header comment\nFOO=bar\n# another\nBAZ=qux\n');
    expect(m.size).toBe(2);
    expect(m.has('# header comment')).toBe(false);
  });

  it('handles `=` inside values', () => {
    const m = parseEnvLines('SPILO_CONFIGURATION={"key":"val=eq"}\n');
    expect(m.get('SPILO_CONFIGURATION')).toBe('{"key":"val=eq"}');
  });

  it('strips balanced double quotes from values', () => {
    const m = parseEnvLines('FOO="hello world"\n');
    expect(m.get('FOO')).toBe('hello world');
  });

  it('strips balanced single quotes from values', () => {
    const m = parseEnvLines("FOO='hello world'\n");
    expect(m.get('FOO')).toBe('hello world');
  });

  it('preserves unbalanced quotes verbatim', () => {
    const m = parseEnvLines('FOO="unterminated\n');
    expect(m.get('FOO')).toBe('"unterminated');
  });

  it('last-write-wins on duplicate keys', () => {
    const m = parseEnvLines('FOO=first\nFOO=second\nFOO=third\n');
    expect(m.get('FOO')).toBe('third');
    expect(m.size).toBe(1);
  });

  it('keeps an empty value', () => {
    const m = parseEnvLines('FOO=\nBAR=value\n');
    expect(m.get('FOO')).toBe('');
    expect(m.get('BAR')).toBe('value');
  });

  it('handles CRLF line endings', () => {
    const m = parseEnvLines('FOO=bar\r\nBAZ=qux\r\n');
    expect(m.get('FOO')).toBe('bar');
    expect(m.get('BAZ')).toBe('qux');
  });

  it('ignores lines without `=`', () => {
    const m = parseEnvLines('FOO=bar\nthis is not an env line\nBAZ=qux\n');
    expect(m.size).toBe(2);
  });

  it('preserves a trailing space inside a credential value', () => {
    const m = parseEnvLines('PASSWORD=secret \n');
    expect(m.get('PASSWORD')).toBe('secret ');
  });
});

describe('diffEnvFiles', () => {
  it('returns only unchanged entries when both sides match byte-for-byte', () => {
    const out = diffEnvFiles('FOO=bar\nBAZ=qux\n', 'FOO=bar\nBAZ=qux\n');
    expect(out.every((e) => e.kind === 'unchanged')).toBe(true);
    expect(out).toHaveLength(2);
  });

  it('classifies a new key as added', () => {
    const out = diffEnvFiles('FOO=bar\nNEW=value\n', 'FOO=bar\n');
    const added = out.find((e) => e.key === 'NEW');
    expect(added?.kind).toBe('added');
    expect(added?.newValue).toBe('value');
  });

  it('classifies a removed key as removed', () => {
    const out = diffEnvFiles('FOO=bar\n', 'FOO=bar\nGONE=value\n');
    const removed = out.find((e) => e.key === 'GONE');
    expect(removed?.kind).toBe('removed');
    expect(removed?.oldValue).toBe('value');
  });

  it('classifies a changed key with both old and new values', () => {
    const out = diffEnvFiles('FOO=new\n', 'FOO=old\n');
    expect(out).toHaveLength(1);
    expect(out[0]).toEqual({
      key: 'FOO',
      kind: 'changed',
      oldValue: 'old',
      newValue: 'new',
    });
  });

  it('sorts entries: added, changed, removed, unchanged, alpha within group', () => {
    const out = diffEnvFiles(
      'BBB=new\nAAA=val\nCCC_NEW=val\nDDD=val\n',
      'BBB=old\nAAA=val\nDDD=val\nEEE_GONE=val\n',
    );
    const order = out.map((e) => `${e.kind}:${e.key}`);
    // added group first (CCC_NEW), then changed (BBB), then removed (EEE_GONE),
    // then unchanged alpha (AAA, DDD).
    expect(order).toEqual([
      'added:CCC_NEW',
      'changed:BBB',
      'removed:EEE_GONE',
      'unchanged:AAA',
      'unchanged:DDD',
    ]);
  });

  it('treats two empty inputs as zero entries', () => {
    expect(diffEnvFiles('', '')).toEqual([]);
  });
});

describe('renderEnvDiff (masked default)', () => {
  it('emits one line per changed/added/removed entry, masking values', () => {
    const entries: EnvDiffEntry[] = [
      { key: 'KICI_NEW_KEY', kind: 'added', newValue: 'AKIA-secret' },
      { key: 'KICI_PROD_DB_PASSWORD', kind: 'changed', oldValue: 'hunter2', newValue: 'tr0ub4dor' },
      { key: 'KICI_OLD_KEY', kind: 'removed', oldValue: 'zzz' },
      { key: 'KICI_STABLE', kind: 'unchanged' },
    ];
    const lines = renderEnvDiff(entries);
    const joined = lines.join('\n');
    expect(joined).toContain('KICI_PROD_DB_PASSWORD: changed');
    expect(joined).toContain('KICI_NEW_KEY: added');
    expect(joined).toContain('KICI_OLD_KEY: removed');
    expect(joined).toContain('1 other key(s) unchanged');
    // Mask invariant: no literal values appear in default-render output.
    expect(joined).not.toContain('hunter2');
    expect(joined).not.toContain('tr0ub4dor');
    expect(joined).not.toContain('AKIA-secret');
    expect(joined).not.toContain('zzz');
  });

  it('shows "0 key(s) drifted" when every entry is unchanged', () => {
    const entries: EnvDiffEntry[] = [
      { key: 'A', kind: 'unchanged' },
      { key: 'B', kind: 'unchanged' },
    ];
    // unchangedCount > 0 path: counts unchanged keys explicitly.
    const lines = renderEnvDiff(entries);
    expect(lines).toEqual(['2 other key(s) unchanged']);
  });

  it('shows the fallback line when entries is empty', () => {
    const lines = renderEnvDiff([]);
    expect(lines).toEqual(['0 key(s) drifted (env content matches)']);
  });
});

describe('renderEnvDiff (reveal: true)', () => {
  it('shows old + new values for changed entries', () => {
    const entries: EnvDiffEntry[] = [
      { key: 'KICI_PROD_DB_PASSWORD', kind: 'changed', oldValue: 'hunter2', newValue: 'tr0ub4dor' },
    ];
    const lines = renderEnvDiff(entries, { reveal: true });
    const joined = lines.join('\n');
    expect(joined).toContain('KICI_PROD_DB_PASSWORD: changed');
    expect(joined).toContain('- old=hunter2');
    expect(joined).toContain('+ new=tr0ub4dor');
  });

  it('shows only new for added entries', () => {
    const entries: EnvDiffEntry[] = [{ key: 'NEW', kind: 'added', newValue: 'fresh-secret' }];
    const lines = renderEnvDiff(entries, { reveal: true });
    const joined = lines.join('\n');
    expect(joined).toContain('+ new=fresh-secret');
    expect(joined).not.toContain('old=');
  });

  it('shows only old for removed entries', () => {
    const entries: EnvDiffEntry[] = [{ key: 'GONE', kind: 'removed', oldValue: 'dead-secret' }];
    const lines = renderEnvDiff(entries, { reveal: true });
    const joined = lines.join('\n');
    expect(joined).toContain('- old=dead-secret');
    expect(joined).not.toContain('new=');
  });
});

describe('renderEnvDiff (color)', () => {
  it('emits ANSI escapes around the kind label when color=true', () => {
    const entries: EnvDiffEntry[] = [
      { key: 'A', kind: 'added', newValue: 'x' },
      { key: 'B', kind: 'changed', oldValue: 'x', newValue: 'y' },
      { key: 'C', kind: 'removed', oldValue: 'x' },
    ];
    const lines = renderEnvDiff(entries, { color: true });
    const joined = lines.join('\n');
    // At least one ANSI escape introducer should appear when color is on.
    expect(/\x1b\[/.test(joined)).toBe(true);
  });

  it('emits NO ANSI escapes when color=false (default)', () => {
    const entries: EnvDiffEntry[] = [
      { key: 'A', kind: 'added', newValue: 'x' },
      { key: 'B', kind: 'changed', oldValue: 'x', newValue: 'y' },
    ];
    const lines = renderEnvDiff(entries);
    const joined = lines.join('\n');
    expect(/\x1b\[/.test(joined)).toBe(false);
  });

  it('color-wraps revealed value lines (red for old, green for new)', () => {
    const entries: EnvDiffEntry[] = [
      { key: 'KEY', kind: 'changed', oldValue: 'OLD', newValue: 'NEW' },
    ];
    const lines = renderEnvDiff(entries, { reveal: true, color: true });
    const joined = lines.join('\n');
    expect(joined).toMatch(/\x1b\[31m.*OLD.*\x1b\[0m/);
    expect(joined).toMatch(/\x1b\[32m.*NEW.*\x1b\[0m/);
  });
});

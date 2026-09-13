import { describe, it, expect } from 'vitest';
import { detectOsMismatchHints } from './os-mismatch-hint.js';

const lockWith = (values: string[]) => ({
  workflows: [
    {
      name: 'wf',
      jobs: [{ name: 'greet', runsOn: values.map((value) => ({ kind: 'exact', value })) }],
    },
  ],
});

describe('detectOsMismatchHints', () => {
  it('returns no hint when the job requests the host OS', () => {
    expect(detectOsMismatchHints(lockWith(['kici:os:linux']), 'linux', 'x64')).toEqual([]);
  });

  it('returns no hint when the job requests no kici:os label', () => {
    expect(detectOsMismatchHints(lockWith(['default']), 'darwin', 'arm64')).toEqual([]);
  });

  it('warns when the job wants kici:os:linux but the host is darwin', () => {
    const hints = detectOsMismatchHints(lockWith(['kici:os:linux']), 'darwin', 'arm64');
    expect(hints).toHaveLength(1);
    expect(hints[0]).toContain('greet');
    expect(hints[0]).toContain('kici:os:linux');
    expect(hints[0]).toContain('darwin');
    expect(hints[0]).toContain('kici:os:macos');
  });

  it('does not warn when at least one requested os label matches the host', () => {
    expect(
      detectOsMismatchHints(lockWith(['kici:os:linux', 'kici:os:macos']), 'darwin', 'arm64'),
    ).toEqual([]);
  });

  it('tolerates a malformed lock (no workflows) without throwing', () => {
    expect(detectOsMismatchHints({}, 'linux', 'x64')).toEqual([]);
  });
});

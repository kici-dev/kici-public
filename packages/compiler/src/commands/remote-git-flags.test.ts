import { describe, expect, it } from 'vitest';
import { parseRemoteGitFlags, RemoteGitFlagError } from './remote-git-flags.js';

/** The error `parseRemoteGitFlags` throws for `raw`, or undefined. */
function thrownBy(raw: Parameters<typeof parseRemoteGitFlags>[0]): unknown {
  try {
    parseRemoteGitFlags(raw);
  } catch (e) {
    return e;
  }
  return undefined;
}

describe('parseRemoteGitFlags', () => {
  it('parses a non-negative --git-depth', () => {
    expect(parseRemoteGitFlags({ gitDepth: '0' }).gitDepth).toBe(0);
    expect(parseRemoteGitFlags({ gitDepth: '25' }).gitDepth).toBe(25);
  });

  it('leaves --git-depth unset when the flag is absent', () =>
    expect(parseRemoteGitFlags({}).gitDepth).toBeUndefined());

  it.each(['-1', '1.5', 'all', '', ' 3', '1e3'])('rejects --git-depth %j', (v) => {
    const err = thrownBy({ gitDepth: v });
    expect(err).toBeInstanceOf(RemoteGitFlagError);
    expect((err as Error).message).toBe(`--git-depth must be a non-negative integer, got '${v}'`);
  });

  it('passes the tag policy through in all three states', () => {
    expect(parseRemoteGitFlags({ gitTags: true }).gitTags).toBe(true);
    expect(parseRemoteGitFlags({ gitTags: false }).gitTags).toBe(false);
    expect(parseRemoteGitFlags({}).gitTags).toBeUndefined();
  });

  it('commit defaults to true', () => expect(parseRemoteGitFlags({}).commit).toBe(true));

  it('--no-commit turns the synthetic commit off', () =>
    expect(parseRemoteGitFlags({ commit: false }).commit).toBe(false));

  it.each([{ commitMessage: 'wip' }, { commitAuthor: 'Ada <ada@example.com>' }])(
    'rejects %j with --no-commit',
    (extra) => {
      const err = thrownBy({ commit: false, ...extra });
      expect(err).toBeInstanceOf(RemoteGitFlagError);
      expect((err as Error).message).toBe(
        '--commit-message and --commit-author need a synthetic commit; drop --no-commit',
      );
    },
  );

  it.each(['', '   ', '\n\t'])('rejects --commit-message %j', (message) => {
    const err = thrownBy({ commitMessage: message });
    expect(err).toBeInstanceOf(RemoteGitFlagError);
    expect((err as Error).message).toBe('--commit-message must not be empty');
  });

  it('keeps the raw commit message and parses the author', () =>
    expect(
      parseRemoteGitFlags({ commitMessage: 'try it', commitAuthor: 'Ada L <ada@example.com>' }),
    ).toEqual({
      commit: true,
      commitMessage: 'try it',
      commitAuthor: { name: 'Ada L', email: 'ada@example.com' },
      tags: [],
    }));

  it('leaves the commit message and author unset when the flags are absent', () => {
    const flags = parseRemoteGitFlags({});
    expect(flags.commitMessage).toBeUndefined();
    expect(flags.commitAuthor).toBeUndefined();
  });

  it('validates every --tag before anything is built', () => {
    // fails-when: only the first --tag is checked
    const err = thrownBy({ tag: ['ok', 'a..b'] });
    expect(err).toBeInstanceOf(RemoteGitFlagError);
    expect((err as Error).message).toBe("--tag 'a..b' is not a valid tag name");
  });

  it.each([
    [{ tag: ['-lead'] }, "--tag '-lead' is not a valid tag name"],
    [{ commitAuthor: 'Ada' }, `--commit-author must look like "Name <email>", got 'Ada'`],
  ])('wraps the validator error for %j in RemoteGitFlagError', (raw, message) => {
    // fails-when: a plain Error escapes and the CLI prints a stack trace and exits 1
    const err = thrownBy(raw);
    expect(err).toBeInstanceOf(RemoteGitFlagError);
    expect((err as Error).message).toBe(message);
  });

  it('de-duplicates repeated --tag values', () =>
    expect(parseRemoteGitFlags({ tag: ['v1', 'v2', 'v1'] }).tags).toEqual(['v1', 'v2']));

  it('accepts valid tag names', () =>
    expect(parseRemoteGitFlags({ tag: ['v1.2.3', 'release/next'] }).tags).toEqual([
      'v1.2.3',
      'release/next',
    ]));
});

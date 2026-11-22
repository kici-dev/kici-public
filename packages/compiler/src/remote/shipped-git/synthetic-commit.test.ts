import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';
import { KICI_GIT_IDENTITY } from './git-ship-types.js';
import {
  parseCommitAuthor,
  resolveSyntheticAuthor,
  validateSyntheticTagName,
} from './synthetic-commit.js';

describe('parseCommitAuthor', () => {
  it('parses "Name <email>"', () =>
    expect(parseCommitAuthor('Ada Lovelace <ada@example.com>')).toEqual({
      name: 'Ada Lovelace',
      email: 'ada@example.com',
    }));

  it.each(['Ada', '<ada@x>', 'Ada <>', 'Ada <a@b> extra', 'Ada <a b@c>', ' <a@b>', 'A\nB <a@b>'])(
    'rejects %j',
    (v) =>
      // fails-when: a value git would reject, or would split into another identity, is accepted
      expect(() => parseCommitAuthor(v)).toThrow(
        `--commit-author must look like "Name <email>", got '${v}'`,
      ),
  );
});

describe('resolveSyntheticAuthor', () => {
  let root: string;
  let repo: string;

  beforeEach(() => {
    root = mkdtempSync(join(os.tmpdir(), 'kici-synthetic-author-'));
    const globalConfig = join(root, 'gitconfig');
    writeFileSync(globalConfig, '');
    // The developer's own identity must not stand in for the repository's.
    vi.stubEnv('GIT_CONFIG_NOSYSTEM', '1');
    vi.stubEnv('GIT_CONFIG_GLOBAL', globalConfig);
    vi.stubEnv('GIT_AUTHOR_NAME', undefined);
    vi.stubEnv('GIT_AUTHOR_EMAIL', undefined);
    repo = join(root, 'repo');
    execFileSync('git', ['init', '-q', repo]);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(root, { recursive: true, force: true });
  });

  const setConfig = (key: string, value: string): void => {
    execFileSync('git', ['-C', repo, 'config', key, value]);
  };

  it('defaults the author to the developer identity', () => {
    setConfig('user.name', 'Dev');
    setConfig('user.email', 'dev@example.com');
    // fails-when: the developer's configured identity is not read
    expect(resolveSyntheticAuthor(repo)).toEqual({ name: 'Dev', email: 'dev@example.com' });
  });

  it.each([
    ['name unset', 'user.email', 'dev@example.com'],
    ['email unset', 'user.name', 'Dev'],
  ])('falls back to KiCI when %s', (_case, key, value) => {
    setConfig(key, value);
    // fails-when: a half-configured identity is used, or git's own hostname guess stands in
    expect(resolveSyntheticAuthor(repo)).toEqual({ name: 'KiCI', email: 'noreply@kici.dev' });
    expect(resolveSyntheticAuthor(repo)).toEqual(KICI_GIT_IDENTITY);
  });

  it('prefers author.name / author.email over user.name / user.email', () => {
    setConfig('user.name', 'Dev');
    setConfig('user.email', 'dev@example.com');
    setConfig('author.name', 'Author');
    setConfig('author.email', 'author@example.com');
    // fails-when: the author tier is skipped, so the identity differs from the developer's own commit
    expect(resolveSyntheticAuthor(repo)).toEqual({ name: 'Author', email: 'author@example.com' });
  });

  it('resolves each field on its own, as git does', () => {
    setConfig('author.name', 'Author');
    setConfig('user.email', 'dev@example.com');
    expect(resolveSyntheticAuthor(repo)).toEqual({ name: 'Author', email: 'dev@example.com' });
  });

  it('prefers GIT_AUTHOR_NAME / GIT_AUTHOR_EMAIL over the config', () => {
    setConfig('author.name', 'Author');
    setConfig('author.email', 'author@example.com');
    vi.stubEnv('GIT_AUTHOR_NAME', 'Env');
    vi.stubEnv('GIT_AUTHOR_EMAIL', 'env@example.com');
    // fails-when: the environment tier is skipped
    expect(resolveSyntheticAuthor(repo)).toEqual({ name: 'Env', email: 'env@example.com' });
  });

  it('prefers the --commit-author override', () => {
    setConfig('user.name', 'Dev');
    setConfig('user.email', 'dev@example.com');
    const override = { name: 'Ada', email: 'ada@example.com' };
    expect(resolveSyntheticAuthor(repo, override)).toEqual(override);
  });
});

describe('validateSyntheticTagName', () => {
  it.each(['v1.0.0', 'release/2026-11', 'v9.9.9-e2e'])('accepts %s', (n) =>
    expect(() => validateSyntheticTagName(n)).not.toThrow(),
  );

  // '-lead': `git check-ref-format refs/tags/-lead` exits 0 (git 2.47.3), so only the explicit
  // leading-dash check rejects it.
  // fails-when: the leading-dash check is missing — '-lead' passes and `tag -a … -lead` parses it as an option
  it.each(['a..b', 'bad tag', 'x~1', '-lead', 'end.lock', ''])('rejects %j', (n) =>
    expect(() => validateSyntheticTagName(n)).toThrow(`--tag '${n}' is not a valid tag name`),
  );
});

describe('validateSyntheticTagName special names', () => {
  // Every name below passes `git check-ref-format refs/tags/<name>` (git 2.47.3), so only the
  // special-name rule rejects it.
  // fails-when: the special-name rule is removed, or a name is dropped from its list
  it.each([
    'HEAD',
    '@',
    'FETCH_HEAD',
    'ORIG_HEAD',
    'MERGE_HEAD',
    'CHERRY_PICK_HEAD',
    'REVERT_HEAD',
    'BISECT_HEAD',
    'AUTO_MERGE',
  ])('rejects the special ref name %s', (n) =>
    expect(() => validateSyntheticTagName(n)).toThrow(
      `--tag '${n}' is not a valid tag name: git reserves '${n}' as a special ref name`,
    ),
  );

  // fails-when: the refs/ prefix rule is removed
  it.each(['refs/x', 'refs/tags/v1'])('rejects the refs/-prefixed name %s', (n) =>
    expect(() => validateSyntheticTagName(n)).toThrow(
      `--tag '${n}' is not a valid tag name: a tag name cannot start with 'refs/'`,
    ),
  );

  // breaks-if-wrong: an ordinary name, or one that only contains a special name, still passes
  it.each(['v1.2.3', 'release/2026-11', 'HEAD-1', 'my/HEAD', 'xrefs/y', 'release/refs'])(
    'accepts the tag name %s',
    (n) => expect(() => validateSyntheticTagName(n)).not.toThrow(),
  );
});

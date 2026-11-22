import { describe, expect, it } from 'vitest';
import { GitObjectFormat } from './git-ship-types.js';
import {
  renderShippedGitConfig,
  shippedOriginUrl,
  stripUrlUserinfo,
} from './shipped-git-config.js';

const CORE_SHA1 =
  '[core]\n\trepositoryformatversion = 0\n\tfilemode = true\n\tbare = false\n\tlogallrefupdates = true\n';

describe('stripUrlUserinfo', () => {
  it.each([
    ['https://user:tok@example.com/r.git', 'https://example.com/r.git'],
    ['https://x-access-token:ghp_abc@github.com/o/r.git', 'https://github.com/o/r.git'],
    ['ssh://git@host:22/o/r.git', 'ssh://host:22/o/r.git'],
    ['git@github.com:o/r.git', 'github.com:o/r.git'],
    ['https://example.com/r.git', 'https://example.com/r.git'],
    ['/srv/repos/r.git', '/srv/repos/r.git'],
  ])('strips userinfo from %s', (input, expected) =>
    expect(stripUrlUserinfo(input)).toBe(expected),
  );

  it.each([
    // fails-when: the token survives because only the first '@' is treated as the userinfo end
    ['https://user:p@ss@example.com/r.git', 'https://example.com/r.git'],
    // fails-when: an '@' in the path is mistaken for userinfo and the host is cut away
    ['https://example.com/o/r@v1.git', 'https://example.com/o/r@v1.git'],
    ['file:///srv/repos/r.git', 'file:///srv/repos/r.git'],
    ['./relative/r.git', './relative/r.git'],
    ['github.com:o/r.git', 'github.com:o/r.git'],
  ])('handles the edge case %s', (input, expected) =>
    expect(stripUrlUserinfo(input)).toBe(expected),
  );
});

describe('shippedOriginUrl', () => {
  it.each([
    // fails-when: a token in the query string ships
    ['https://gitlab.example/x.git?private_token=abc', 'https://gitlab.example/x.git'],
    ['https://u:p@gitlab.example/x.git?private_token=abc#frag', 'https://gitlab.example/x.git'],
    ['https://example.com/r.git#main', 'https://example.com/r.git'],
    // breaks-if-wrong: a URL with no userinfo, query or fragment ships unchanged
    ['https://example.com/r.git', 'https://example.com/r.git'],
    ['git@github.com:o/r.git', 'github.com:o/r.git'],
    ['/srv/repos/r.git', '/srv/repos/r.git'],
  ])('ships %s as %s', (input, expected) => expect(shippedOriginUrl(input)).toBe(expected));
});

describe('renderShippedGitConfig', () => {
  it('writes tagOpt for a no-tags ship, as git clone --no-tags does', () =>
    expect(
      renderShippedGitConfig({
        objectFormat: GitObjectFormat.Sha1,
        originUrl: 'https://example.com/r.git',
        branch: 'main',
        depth: 1,
        noTags: true,
      }),
    ).toBe(
      CORE_SHA1 +
        '[remote "origin"]\n\turl = https://example.com/r.git\n\ttagOpt = --no-tags\n' +
        '\tfetch = +refs/heads/main:refs/remotes/origin/main\n' +
        '[branch "main"]\n\tremote = origin\n\tmerge = refs/heads/main\n',
    ));

  it('renders a depth-1 single-branch config', () =>
    expect(
      renderShippedGitConfig({
        objectFormat: GitObjectFormat.Sha1,
        originUrl: 'https://example.com/r.git',
        branch: 'main',
        depth: 1,
      }),
    ).toBe(
      CORE_SHA1 +
        '[remote "origin"]\n\turl = https://example.com/r.git\n\tfetch = +refs/heads/main:refs/remotes/origin/main\n' +
        '[branch "main"]\n\tremote = origin\n\tmerge = refs/heads/main\n',
    ));

  it('uses the wildcard refspec at depth 0', () =>
    expect(
      renderShippedGitConfig({
        objectFormat: GitObjectFormat.Sha1,
        originUrl: 'https://example.com/r.git',
        branch: 'main',
        depth: 0,
      }),
    ).toBe(
      CORE_SHA1 +
        '[remote "origin"]\n\turl = https://example.com/r.git\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n' +
        '[branch "main"]\n\tremote = origin\n\tmerge = refs/heads/main\n',
    ));

  it('writes no remote or branch section without an origin', () =>
    expect(
      renderShippedGitConfig({ objectFormat: GitObjectFormat.Sha1, branch: 'main', depth: 1 }),
    ).toBe(CORE_SHA1));

  it('writes no branch section on a detached HEAD', () =>
    expect(
      renderShippedGitConfig({
        objectFormat: GitObjectFormat.Sha1,
        originUrl: 'https://example.com/r.git',
        depth: 1,
      }),
    ).toBe(
      CORE_SHA1 +
        '[remote "origin"]\n\turl = https://example.com/r.git\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n',
    ));

  it('declares the sha256 object format', () =>
    expect(renderShippedGitConfig({ objectFormat: GitObjectFormat.Sha256, depth: 1 })).toBe(
      '[core]\n\trepositoryformatversion = 1\n\tfilemode = true\n\tbare = false\n\tlogallrefupdates = true\n' +
        '[extensions]\n\tobjectformat = sha256\n',
    ));

  it('quotes a URL git would otherwise read as a comment', () =>
    // fails-when: an unquoted '#' truncates the URL when git parses the config
    expect(
      renderShippedGitConfig({
        objectFormat: GitObjectFormat.Sha1,
        originUrl: '/srv/repos/r#1.git',
        depth: 1,
      }),
    ).toContain('\turl = "/srv/repos/r#1.git"\n'));

  it('escapes a double quote in a branch subsection name', () =>
    // fails-when: the branch name closes the subsection quote early
    expect(
      renderShippedGitConfig({
        objectFormat: GitObjectFormat.Sha1,
        originUrl: 'https://example.com/r.git',
        branch: 'we"ird',
        depth: 1,
      }),
    ).toContain('[branch "we\\"ird"]\n'));
});

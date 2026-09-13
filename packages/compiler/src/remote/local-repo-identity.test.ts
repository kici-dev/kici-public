import { describe, it, expect } from 'vitest';
import { parseGitOrigin } from './local-repo-identity.js';

describe('parseGitOrigin', () => {
  it('parses ssh scp-style github with .git', () => {
    expect(parseGitOrigin('git@github.com:acme/app.git')).toEqual({
      provider: 'github',
      repoIdentifier: 'acme/app',
    });
  });
  it('parses https github without .git', () => {
    expect(parseGitOrigin('https://github.com/acme/app')).toEqual({
      provider: 'github',
      repoIdentifier: 'acme/app',
    });
  });
  it('parses ssh:// gitlab with .git', () => {
    expect(parseGitOrigin('ssh://git@gitlab.com/acme/app.git')).toEqual({
      provider: 'gitlab',
      repoIdentifier: 'acme/app',
    });
  });
  it('parses https bitbucket', () => {
    expect(parseGitOrigin('https://bitbucket.org/acme/app.git')).toEqual({
      provider: 'bitbucket',
      repoIdentifier: 'acme/app',
    });
  });
  it('parses a nested gitlab subgroup path', () => {
    expect(parseGitOrigin('git@gitlab.com:acme/team/app.git')).toEqual({
      provider: 'gitlab',
      repoIdentifier: 'acme/team/app',
    });
  });
  it('returns null for unrecognized host', () => {
    expect(parseGitOrigin('https://example.com/acme/app.git')).toBeNull();
  });
  it('returns null for garbage', () => {
    expect(parseGitOrigin('not a url')).toBeNull();
  });
});

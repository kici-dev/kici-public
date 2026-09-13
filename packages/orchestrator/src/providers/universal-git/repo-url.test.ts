import { describe, it, expect } from 'vitest';
import { UniversalGitRepoUrlBuilder, splitRepoIdentifier } from './repo-url.js';

describe('splitRepoIdentifier', () => {
  it('splits owner/name', () => {
    expect(splitRepoIdentifier('alice/repo')).toEqual({ owner: 'alice', name: 'repo' });
  });

  it('treats trailing segment as name (GitLab subgroups)', () => {
    expect(splitRepoIdentifier('group/sub/project')).toEqual({
      owner: 'group/sub',
      name: 'project',
    });
  });

  it('throws on malformed input (no slash)', () => {
    expect(() => splitRepoIdentifier('nope')).toThrow(/contain at least one/);
  });

  it('throws on empty owner or name', () => {
    expect(() => splitRepoIdentifier('/name')).toThrow();
    expect(() => splitRepoIdentifier('owner/')).toThrow();
  });
});

describe('UniversalGitRepoUrlBuilder', () => {
  it('substitutes {owner} and {name}', () => {
    const builder = new UniversalGitRepoUrlBuilder(
      'https://forgejo.example.com/{owner}/{name}.git',
    );
    expect(builder.buildCloneUrl('alice/repo')).toBe('https://forgejo.example.com/alice/repo.git');
  });

  it('substitutes {repo} with the full identifier', () => {
    const builder = new UniversalGitRepoUrlBuilder('https://gitlab.example.com/{repo}.git');
    expect(builder.buildCloneUrl('group/sub/project')).toBe(
      'https://gitlab.example.com/group/sub/project.git',
    );
  });

  it('substitutes all three placeholders in one template', () => {
    const builder = new UniversalGitRepoUrlBuilder(
      'ssh://git@forge.example/{owner}/{name}.git#{repo}',
    );
    expect(builder.buildCloneUrl('a/b')).toBe('ssh://git@forge.example/a/b.git#a/b');
  });

  it('throws on empty template', () => {
    expect(() => new UniversalGitRepoUrlBuilder('')).toThrow(/non-empty/);
    expect(() => new UniversalGitRepoUrlBuilder('   ')).toThrow(/non-empty/);
  });

  it('buildRawFileUrl falls back to the clone URL (universal-git has no raw API)', () => {
    const builder = new UniversalGitRepoUrlBuilder(
      'https://forgejo.example.com/{owner}/{name}.git',
    );
    expect(builder.buildRawFileUrl('alice/repo', 'main', '.kici/kici.lock.json')).toBe(
      'https://forgejo.example.com/alice/repo.git',
    );
  });

  it('exposes provider === "generic"', () => {
    const builder = new UniversalGitRepoUrlBuilder('https://host/{repo}.git');
    expect(builder.provider).toBe('generic');
  });
});

import { describe, expect, it } from 'vitest';
import { repoIdentifierFromUrl } from './repo-identifier.js';

describe('repoIdentifierFromUrl', () => {
  it.each([
    ['https://github.com/acme/app.git', 'acme/app'],
    ['https://github.com/acme/app', 'acme/app'],
    ['http://127.0.0.1:3000/acme/app', 'acme/app'],
    ['git@github.com:acme/app.git', 'acme/app'],
    ['ssh://git@127.0.0.1:2222/acme/app.git', 'acme/app'],
    ['ssh://host/acme/app', 'acme/app'],
    ['https://gitlab.com/group/sub/app.git', 'group/sub/app'],
  ])('names %s as %s', (input, expected) => {
    expect(repoIdentifierFromUrl(input)).toBe(expected);
  });

  it.each([
    ['file:///srv/repos/app', 'file:///srv/repos/app'],
    ['C:\\repos\\app', 'C:\\repos\\app'],
    ['git@host:/srv/repos/app.git', 'git@host:/srv/repos/app'],
  ])('leaves a non-forge URL %s unchanged', (input, expected) => {
    expect(repoIdentifierFromUrl(input)).toBe(expected);
  });
});

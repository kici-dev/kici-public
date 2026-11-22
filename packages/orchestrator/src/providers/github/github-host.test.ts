import { describe, it, expect } from 'vitest';
import { STATUS_ID_MAX } from '@kici-dev/engine';
import {
  DEFAULT_GITHUB_URL,
  githubApiBaseUrl,
  githubAppInstallUrl,
  githubIdentityProvider,
  githubOctokitOptions,
  isDefaultGithubUrl,
  parseGithubWebUrl,
} from './github-host.js';

describe('parseGithubWebUrl', () => {
  it.each([
    ['https://ghe.corp.example:8443/', 'https://ghe.corp.example:8443'],
    ['https://ghe.corp.example/', 'https://ghe.corp.example'],
    ['  https://ghe.corp.example  ', 'https://ghe.corp.example'],
    ['https://GHE.corp.example', 'https://ghe.corp.example'],
    ['https://github.com/', 'https://github.com'],
  ])('accepts %j as %s', (value, expected) => {
    expect(parseGithubWebUrl(value)).toBe(expected);
  });

  it.each([
    'http://ghe.corp.example',
    'https://ghe.corp.example/path',
    'https://ghe.corp.example/api/v3',
    'https://ghe.corp.example/?x=1',
    'https://ghe.corp.example/#x',
    'https://user:pw@ghe.corp.example',
    'ghe.corp.example',
    '',
    'https://ghe.corp.example\nX=1',
    'https://ghe.\tcorp.example',
  ])('refuses %j, naming --github-url', (value) => {
    // fails-when: a value with a path, a query, a line break or no https scheme
    //   becomes the create URL or the API base
    expect(() => parseGithubWebUrl(value)).toThrow(/--github-url/);
  });

  it.each(['https://api.github.com', 'https://www.github.com', 'https://WWW.GitHub.com/'])(
    'refuses %s and points at https://github.com',
    (value) => {
      // fails-when: the value is taken for a GitHub server and mapped to <host>/api/v3
      expect(() => parseGithubWebUrl(value)).toThrow(/--github-url .*use https:\/\/github\.com$/);
    },
  );

  it.each(['https://acme.ghe.com', 'https://ghe.com'])('refuses a GHE.com host: %s', (value) => {
    // fails-when: a GHE.com host is mapped to /api/v3, where its API is not served
    expect(() => parseGithubWebUrl(value)).toThrow(/GHE\.com/);
  });

  it('refuses a server origin longer than an execution.status id field takes', () => {
    // 'https://' + 120 characters is 128, the frame's bound for repoWebUrl and,
    // as github:<host>, for triggerActorProvider.
    const host = `${'a'.repeat(60)}.${'b'.repeat(55)}.com`;
    expect(parseGithubWebUrl(`https://${host}`)).toHaveLength(STATUS_ID_MAX);
    // fails-when: a server whose origin the wire refuses is stored, and every
    //   execution.status frame of its runs is rejected
    expect(() => parseGithubWebUrl(`https://${host}m`)).toThrow(
      /--github-url must be at most 128 characters/,
    );
  });

  it('names the label it is given', () => {
    expect(() => parseGithubWebUrl('http://ghe.corp.example', 'githubUrl')).toThrow(
      /^githubUrl must be/,
    );
  });
});

describe('isDefaultGithubUrl', () => {
  it('treats unset and https://github.com as github.com, and nothing else', () => {
    expect(isDefaultGithubUrl(undefined)).toBe(true);
    expect(isDefaultGithubUrl(DEFAULT_GITHUB_URL)).toBe(true);
    expect(isDefaultGithubUrl('https://ghe.corp.example')).toBe(false);
  });
});

describe('githubApiBaseUrl', () => {
  it('maps github.com to its API host and a server origin to /api/v3', () => {
    expect(githubApiBaseUrl('https://github.com')).toBe('https://api.github.com');
    expect(githubApiBaseUrl('https://ghe.corp.example')).toBe('https://ghe.corp.example/api/v3');
    expect(githubApiBaseUrl('https://ghe.corp.example:8443')).toBe(
      'https://ghe.corp.example:8443/api/v3',
    );
  });
});

describe('githubOctokitOptions', () => {
  it('gives a github.com client no options at all', () => {
    // breaks-if-wrong: github.com Octokits keep today's options
    expect(githubOctokitOptions(undefined)).toEqual({});
    expect(githubOctokitOptions('https://github.com')).toEqual({});
    expect('baseUrl' in githubOctokitOptions('https://github.com')).toBe(false);
  });

  it('points a server client at its /api/v3 base', () => {
    // fails-when: a server's client keeps Octokit's api.github.com default
    expect(githubOctokitOptions('https://ghe.corp.example')).toEqual({
      baseUrl: 'https://ghe.corp.example/api/v3',
    });
  });
});

describe('githubAppInstallUrl', () => {
  it('uses /apps on github.com and /github-apps on a server', () => {
    expect(githubAppInstallUrl(undefined, 'kici')).toBe(
      'https://github.com/apps/kici/installations/new',
    );
    expect(githubAppInstallUrl('https://ghe.corp.example', 'kici')).toBe(
      'https://ghe.corp.example/github-apps/kici/installations/new',
    );
  });
});

describe('githubIdentityProvider', () => {
  it('keeps github for github.com and names the host of a server, port included', () => {
    // breaks-if-wrong: github.com identity links keep matching
    expect(githubIdentityProvider(undefined)).toBe('github');
    expect(githubIdentityProvider('https://github.com')).toBe('github');
    // fails-when: a server's users share the github.com namespace and match its links
    expect(githubIdentityProvider('https://ghe.corp.example:8443')).toBe(
      'github:ghe.corp.example:8443',
    );
  });
});

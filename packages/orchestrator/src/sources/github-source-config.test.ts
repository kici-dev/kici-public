import { describe, it, expect } from 'vitest';
import {
  displayedSourceConfig,
  githubAppConfigOf,
  githubUrlOfSource,
} from './github-source-config.js';

describe('displayedSourceConfig', () => {
  // fails-when: a never-read config.githubUrl is shown as if it were the server
  it('drops githubUrl from an object or JSON text', () => {
    expect(displayedSourceConfig({ appId: '1', githubUrl: 'https://evil.example' })).toEqual({
      appId: '1',
    });
    expect(displayedSourceConfig('{"appId":"1","githubUrl":"https://evil.example"}')).toEqual({
      appId: '1',
    });
  });

  // breaks-if-wrong: every other key, and an empty config, show unchanged
  it('keeps every other key', () => {
    expect(displayedSourceConfig({ appId: '1', label: 'x' })).toEqual({ appId: '1', label: 'x' });
    expect(displayedSourceConfig(null)).toEqual({});
  });
});

describe('githubAppConfigOf', () => {
  it('reads config given as a JSON string or as an object', () => {
    const base = { routing_key: 'github:1', privateKey: 'pem', github_url: null };
    expect(githubAppConfigOf({ ...base, config: '{"appId":"1"}' })).toEqual({
      appId: '1',
      privateKey: 'pem',
    });
    expect(githubAppConfigOf({ ...base, config: { appId: '1' } })).toEqual({
      appId: '1',
      privateKey: 'pem',
    });
  });

  it('returns githubUrl only when the source stores one', () => {
    const ghes = githubAppConfigOf({
      routing_key: 'github:1',
      privateKey: 'pem',
      config: '{"appId":"1"}',
      github_url: 'https://ghe.corp.example',
    });
    // fails-when: the stored server is dropped, so calls for a GHES source go to github.com
    expect(ghes).toEqual({ appId: '1', privateKey: 'pem', githubUrl: 'https://ghe.corp.example' });
    const dotcom = githubAppConfigOf({
      routing_key: 'github:1',
      privateKey: 'pem',
      config: '{"appId":"1"}',
      github_url: null,
    });
    // breaks-if-wrong: a github.com source's config carries no githubUrl key at all
    expect('githubUrl' in dotcom).toBe(false);
  });

  // An earlier release's generic config update merges any key a token scoped to
  // the source sends, so during a rolling upgrade such a peer can still store
  // config.githubUrl.
  // fails-when: a config.githubUrl an older peer stored becomes the App's server
  it('ignores a githubUrl in config', () => {
    expect(
      githubAppConfigOf({
        routing_key: 'github:1',
        privateKey: 'pem',
        config: { appId: '1', githubUrl: 'https://evil.example' },
        github_url: null,
      }),
    ).toEqual({ appId: '1', privateKey: 'pem' });
    // breaks-if-wrong: the column still wins over (and is not displaced by) the config key
    expect(
      githubAppConfigOf({
        routing_key: 'github:1',
        privateKey: 'pem',
        config: { appId: '1', githubUrl: 'https://evil.example' },
        github_url: 'https://ghe.corp.example',
      }).githubUrl,
    ).toBe('https://ghe.corp.example');
  });

  it('throws naming the routing key when the App id is missing', () => {
    expect(() =>
      githubAppConfigOf({
        routing_key: 'github:9',
        privateKey: 'pem',
        config: '{}',
        github_url: null,
      }),
    ).toThrow('Source github:9 has no stored GitHub App id');
  });
});

describe('githubUrlOfSource', () => {
  it('names a GitHub Enterprise Server', () => {
    expect(githubUrlOfSource({ github_url: 'https://ghe.corp.example' })).toBe(
      'https://ghe.corp.example',
    );
  });

  it('names no server for github.com, even a stored https://github.com', () => {
    // fails-when: a stored default makes a github.com run's frame gain repoWebUrl
    expect(githubUrlOfSource({ github_url: 'https://github.com' })).toBeUndefined();
    // breaks-if-wrong: an ordinary github.com source still names none
    expect(githubUrlOfSource({ github_url: null })).toBeUndefined();
  });
});

describe('a stored server that is not a GitHub web URL', () => {
  const planted = [
    'https://evil.example/path',
    'http://ghe.corp.example',
    'ghe.corp.example',
    '',
    42,
  ];

  // fails-when: a hand-edited github_url becomes the base URL of the App's JWT
  //   and installation-token calls
  it.each(planted)('refuses %j instead of naming a server', (githubUrl) => {
    expect(() => githubUrlOfSource({ github_url: githubUrl as string })).toThrow(
      /stored GitHub server URL/,
    );
  });

  it.each(planted)(
    'refuses to build the App config for %j, naming the routing key',
    (githubUrl) => {
      expect(() =>
        githubAppConfigOf({
          routing_key: 'github:7',
          privateKey: 'pem',
          config: { appId: '7' },
          github_url: githubUrl as string,
        }),
      ).toThrow(/^Source github:7 .*stored GitHub server URL/);
    },
  );

  // breaks-if-wrong: a server the admin API stored still reads back unchanged
  it('reads back a stored origin unchanged', () => {
    expect(githubUrlOfSource({ github_url: 'https://ghe.corp.example:8443' })).toBe(
      'https://ghe.corp.example:8443',
    );
  });
});

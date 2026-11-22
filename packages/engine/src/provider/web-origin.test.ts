import { describe, expect, it } from 'vitest';
import { webOriginOrNull } from './web-origin.js';

describe('webOriginOrNull', () => {
  it('returns the bare origin of an https URL, keeping a port', () => {
    expect(webOriginOrNull('https://ghe.corp.example')).toBe('https://ghe.corp.example');
    expect(webOriginOrNull('https://GHE.corp.example:8443/')).toBe('https://ghe.corp.example:8443');
    // breaks-if-wrong: an absent value is no origin, not an error
    expect(webOriginOrNull(null)).toBeNull();
    expect(webOriginOrNull(undefined)).toBeNull();
  });

  it.each([
    ['a script URL', 'javascript:alert(1)'],
    ['plain HTTP', 'http://ghe.corp.example'],
    ['an origin with a path', 'https://x.example/path'],
    ['an origin with a query', 'https://x.example/?a=1'],
    ['an origin with a fragment', 'https://x.example/#a'],
    ['an origin with credentials', 'https://u:p@x.example'],
    ['an origin with a username only', 'https://evil@x.example'],
    ['text that is no URL', 'not a url'],
    ['an empty string', ''],
  ])('refuses %s', (_label, value) => {
    // fails-when: a value that is not a bare https origin can become a link host
    expect(webOriginOrNull(value)).toBeNull();
  });
});

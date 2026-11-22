import { describe, expect, it } from 'vitest';
import { oidcScopeString, parseScopeList } from './oidc-scopes.js';

describe('parseScopeList', () => {
  // fails-when: only one separator is honoured, so a mixed list yields one bogus scope
  it('splits on commas and any whitespace, dropping empty entries', () => {
    expect(parseScopeList(' groups,\tapi://kici/.default\n, ,openid ')).toEqual([
      'groups',
      'api://kici/.default',
      'openid',
    ]);
  });

  it('reads an unset or blank value as no scopes', () => {
    expect(parseScopeList(undefined)).toEqual([]);
    expect(parseScopeList(' , ')).toEqual([]);
  });
});

describe('oidcScopeString', () => {
  // fails-when: a base scope is dropped, or offline_access is requested again
  it('is the base scopes alone with no extra scope', () => {
    expect(oidcScopeString()).toBe('openid profile email');
  });

  it('appends each extra scope once, after the base scopes', () => {
    expect(oidcScopeString(['groups', 'email', 'groups'])).toBe('openid profile email groups');
  });
});

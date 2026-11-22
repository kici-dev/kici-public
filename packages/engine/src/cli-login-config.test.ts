import { describe, expect, it } from 'vitest';
import {
  CLI_LOGIN_CONFIG_PATH,
  CliLoginConfig,
  CliLoginConfigError,
  OidcScopeToken,
} from './cli-login-config.js';

describe('CliLoginConfig', () => {
  it('accepts the hosted login settings', () => {
    const value = { issuer: 'https://auth.kici.dev/realms/kici-internal', clientId: 'kici-cli' };
    expect(CliLoginConfig.parse(value)).toEqual(value);
  });

  it('accepts an http issuer on a loopback address', () => {
    const value = { issuer: 'http://127.0.0.1:14465/realms/x', clientId: 'kici-cli' };
    expect(CliLoginConfig.parse(value)).toEqual(value);
  });

  // fails-when: the schema strips the field, so the CLI never requests the scopes
  it('accepts extra scopes', () => {
    const value = {
      issuer: 'https://idp.example.com',
      clientId: 'kici-cli',
      extraScopes: ['groups', 'api://kici/.default'],
    };
    expect(CliLoginConfig.parse(value)).toEqual(value);
  });

  // breaks-if-wrong: a body without extra scopes parses to itself, with no added field
  it('adds no extra scopes to a body without them', () => {
    const parsed = CliLoginConfig.parse({ issuer: 'https://idp.example.com', clientId: 'c' });
    expect(Object.keys(parsed)).toEqual(['issuer', 'clientId']);
  });

  it('rejects extra scopes that are not a list of strings', () => {
    for (const extraScopes of ['groups', [1], [null]]) {
      const value = { issuer: 'https://idp.example.com', clientId: 'c', extraScopes };
      expect(CliLoginConfig.safeParse(value).success).toBe(false);
    }
  });

  // fails-when: an extra scope is any string, so a published value with a space or a quote
  // reaches the scope parameter as several scopes or a malformed one
  it.each([
    ['an empty scope', ''],
    ['a scope with a space', 'a b'],
    ['a scope with a double quote', 'a"b'],
    ['a scope with a backslash', 'a\\b'],
  ])('rejects %s as an extra scope', (_name, scope) => {
    const value = { issuer: 'https://idp.example.com', clientId: 'c', extraScopes: [scope] };
    expect(CliLoginConfig.safeParse(value).success).toBe(false);
    expect(OidcScopeToken.safeParse(scope).success).toBe(false);
  });

  // breaks-if-wrong: scope tokens with the punctuation identity providers use still parse
  it('accepts scope tokens with colons, slashes and dots', () => {
    for (const scope of [
      'groups',
      'audience:server:client_id:kici-platform',
      'api://kici/.default',
    ]) {
      expect(OidcScopeToken.parse(scope)).toBe(scope);
    }
  });

  // fails-when: the issuer accepts any string, so the CLI would send the
  // browser to a non-web URL a Platform published
  it.each([
    ['an ftp issuer', { issuer: 'ftp://x', clientId: 'kici-cli' }],
    ['an issuer that is not a URL', { issuer: 'not a url', clientId: 'kici-cli' }],
    ['a javascript: issuer', { issuer: 'javascript:alert(1)', clientId: 'kici-cli' }],
    ['an empty client id', { issuer: 'https://auth.example.com/realms/x', clientId: '' }],
    ['a missing client id', { issuer: 'https://auth.example.com/realms/x' }],
    ['a missing issuer', { clientId: 'kici-cli' }],
  ])('rejects %s', (_name, value) => {
    expect(CliLoginConfig.safeParse(value).success).toBe(false);
  });
});

describe('CLI login settings contract', () => {
  it('serves the login settings under the versioned API prefix', () => {
    expect(CLI_LOGIN_CONFIG_PATH).toBe('/api/v1/cli/login-config');
  });

  it('names the not-configured refusal', () => {
    expect(CliLoginConfigError.enum.login_not_configured).toBe('login_not_configured');
  });
});

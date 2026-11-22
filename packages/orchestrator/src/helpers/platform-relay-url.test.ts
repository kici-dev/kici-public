import { describe, expect, it } from 'vitest';
import { DEFAULT_PLATFORM_RELAY_URL, parsePlatformRelayUrl } from './platform-relay-url.js';

describe('DEFAULT_PLATFORM_RELAY_URL', () => {
  it('is the hosted Platform relay endpoint', () => {
    expect(DEFAULT_PLATFORM_RELAY_URL).toBe('wss://api.kici.dev/ws');
  });
});

describe('parsePlatformRelayUrl', () => {
  // breaks-if-wrong: a well-formed WebSocket URL must pass, trimmed
  it.each([
    ['wss://kici.corp.example/ws', 'wss://kici.corp.example/ws'],
    ['  ws://platform:10042/ws  ', 'ws://platform:10042/ws'],
    [DEFAULT_PLATFORM_RELAY_URL, DEFAULT_PLATFORM_RELAY_URL],
  ])('accepts %s', (value, expected) => {
    expect(parsePlatformRelayUrl(value)).toBe(expected);
  });

  it('refuses an https URL and suggests the WebSocket shape', () => {
    // fails-when: an http(s) API URL is written as KICI_PLATFORM_URL, where
    // the orchestrator's relay client cannot connect
    expect(() => parsePlatformRelayUrl('https://kici.corp.example')).toThrow(/--platform-url/);
    expect(() => parsePlatformRelayUrl('https://kici.corp.example')).toThrow(
      'wss://kici.corp.example/ws',
    );
  });

  it.each([
    ['https://corp.example/kici', 'wss://corp.example/kici/ws'],
    ['https://corp.example/kici/', 'wss://corp.example/kici/ws'],
    ['http://corp.example:8443/a/b//', 'ws://corp.example:8443/a/b/ws'],
  ])('keeps the base path of an http(s) URL %s in the hint', (value, hint) => {
    // fails-when: the hint drops the base path, so the operator copies a URL
    // the Platform does not serve its relay at
    expect(() => parsePlatformRelayUrl(value)).toThrow(`use ${hint} (got`);
  });

  it.each([
    'wss://user:secret@kici.corp.example/ws',
    'wss://user@kici.corp.example/ws',
    'ws://:secret@platform:10042/ws',
  ])('refuses a URL carrying credentials: %s', (value) => {
    // fails-when: credentials are written into the env file as part of KICI_PLATFORM_URL
    expect(() => parsePlatformRelayUrl(value)).toThrow(
      '--platform-url must not carry a username or password',
    );
  });

  it('accepts a WebSocket URL under a base path', () => {
    // breaks-if-wrong: a Platform served under a base path must stay accepted
    expect(parsePlatformRelayUrl('wss://corp.example/kici/ws')).toBe('wss://corp.example/kici/ws');
  });

  it.each(['kici.corp.example', '', '   ', 'ftp://kici.corp.example/ws'])('refuses %j', (value) => {
    expect(() => parsePlatformRelayUrl(value)).toThrow(/--platform-url/);
  });

  it('refuses a value carrying a line break', () => {
    // fails-when: a newline reaches the env file and injects a second assignment
    expect(() => parsePlatformRelayUrl('wss://a/ws\nKICI_MODE=independent')).toThrow(
      /--platform-url/,
    );
    expect(() => parsePlatformRelayUrl('wss://a/ws\rKICI_MODE=independent')).toThrow(
      /--platform-url/,
    );
  });

  it.each([
    ['a tab', 'wss://a/ws\tKICI_MODE=independent'],
    ['an inner space', 'wss://a/ws KICI_MODE=independent'],
    ['a NUL', 'wss://a/\u0000ws'],
    ['a DEL', 'wss://a/\u007fws'],
  ])('refuses a value carrying %s', (_label, value) => {
    // fails-when: the refusal checks only \r and \n, so the WHATWG parser
    // strips the tab and the value is written with it into the env file
    expect(() => parsePlatformRelayUrl(value)).toThrow(/--platform-url must not contain/);
  });
});

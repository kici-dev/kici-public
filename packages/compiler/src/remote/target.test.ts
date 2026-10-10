import { describe, it, expect } from 'vitest';
import { NO_RUN_TARGET_MESSAGE, normalizeOrchestratorUrl, resolveRunTarget } from './target.js';
import type { GlobalConfig } from './config.js';

const LOGIN: GlobalConfig = { pat: 'pat-1', platformEndpoint: 'https://api.kici.dev' };
const SAVED: GlobalConfig = { direct: { url: 'https://ci.example.com/kici/', token: 'saved-t' } };

describe('resolveRunTarget precedence', () => {
  it('prefers the --orchestrator-url flag', () => {
    const r = resolveRunTarget({
      flagUrl: 'https://flag.example.com',
      env: { KICI_ORCHESTRATOR_URL: 'https://env.example.com', KICI_ORCHESTRATOR_TOKEN: 'env-t' },
      config: { ...SAVED, ...LOGIN },
    });
    expect(r).toEqual({
      ok: true,
      target: { kind: 'direct', url: 'https://flag.example.com', token: 'env-t', source: 'flag' },
    });
  });

  it('then the environment', () => {
    const r = resolveRunTarget({
      env: { KICI_ORCHESTRATOR_URL: 'https://env.example.com', KICI_ORCHESTRATOR_TOKEN: 'env-t' },
      config: { ...SAVED, ...LOGIN },
    });
    expect(r.ok && r.target).toEqual({
      kind: 'direct',
      url: 'https://env.example.com',
      token: 'env-t',
      source: 'env',
    });
  });

  it('then the saved direct target', () => {
    const r = resolveRunTarget({ env: {}, config: { ...SAVED, ...LOGIN } });
    expect(r.ok && r.target).toEqual({
      kind: 'direct',
      url: 'https://ci.example.com/kici',
      token: 'saved-t',
      source: 'saved',
    });
  });

  it('then the Platform login', () => {
    const r = resolveRunTarget({ env: {}, config: LOGIN });
    expect(r.ok && r.target).toEqual({
      kind: 'platform',
      endpoint: 'https://api.kici.dev',
      pat: 'pat-1',
      source: 'platform-login',
    });
  });
});

describe('resolveRunTarget token sources', () => {
  it('uses the saved token for a flag naming the saved orchestrator', () => {
    const r = resolveRunTarget({
      flagUrl: 'https://ci.example.com/kici',
      env: {},
      config: SAVED,
    });
    expect(r.ok && r.target).toMatchObject({ token: 'saved-t', source: 'flag' });
  });

  it('refuses a flag naming another orchestrator with no env token', () => {
    const r = resolveRunTarget({ flagUrl: 'https://other.example.com', env: {}, config: SAVED });
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error).toContain('KICI_ORCHESTRATOR_TOKEN');
    expect(!r.ok && r.error).toContain('kici connect https://other.example.com');
  });

  it('ignores an env URL without a token', () => {
    // An agent host carries the agent's own socket URL in its environment.
    const r = resolveRunTarget({
      env: { KICI_ORCHESTRATOR_URL: 'ws://host:4000/ws' },
      config: LOGIN,
    });
    // fails-when: an agent's KICI_ORCHESTRATOR_URL flips a CI step to a direct target
    expect(r.ok && r.target.kind).toBe('platform');
  });

  it('pairs an env token with the saved URL', () => {
    const r = resolveRunTarget({ env: { KICI_ORCHESTRATOR_TOKEN: 'env-t' }, config: SAVED });
    // breaks-if-wrong: env URL + token (or saved URL + env token) still selects direct
    expect(r.ok && r.target).toEqual({
      kind: 'direct',
      url: 'https://ci.example.com/kici',
      token: 'env-t',
      source: 'env',
    });
  });

  it('treats empty env values as unset', () => {
    const r = resolveRunTarget({
      env: { KICI_ORCHESTRATOR_URL: '', KICI_ORCHESTRATOR_TOKEN: '' },
      config: LOGIN,
    });
    expect(r.ok && r.target.kind).toBe('platform');
  });

  it('reports a malformed URL instead of throwing', () => {
    const r = resolveRunTarget({
      flagUrl: 'ftp://h',
      env: { KICI_ORCHESTRATOR_TOKEN: 't' },
      config: {},
    });
    expect(r.ok).toBe(false);
  });

  it('names both commands when nothing is configured', () => {
    const r = resolveRunTarget({ env: {}, config: {} });
    expect(r).toEqual({ ok: false, error: NO_RUN_TARGET_MESSAGE });
    expect(NO_RUN_TARGET_MESSAGE).toContain('kici connect <url>');
    expect(NO_RUN_TARGET_MESSAGE).toContain('kici login');
  });
});

describe('normalizeOrchestratorUrl', () => {
  it('keeps a base path and drops a trailing slash', () => {
    expect(normalizeOrchestratorUrl('https://ci.example.com/kici/')).toBe(
      'https://ci.example.com/kici',
    );
  });

  it('maps an agent socket URL to its HTTP server', () => {
    expect(normalizeOrchestratorUrl('ws://h:4000/ws')).toBe('http://h:4000');
    expect(normalizeOrchestratorUrl('wss://h/ws')).toBe('https://h');
  });

  it('keeps an http path that ends in /ws', () => {
    expect(normalizeOrchestratorUrl('https://h/ws')).toBe('https://h/ws');
  });

  it('throws on a scheme that is not http(s) or ws(s)', () => {
    expect(() => normalizeOrchestratorUrl('ftp://h')).toThrow(/http:\/\/ or https:\/\//);
    expect(() => normalizeOrchestratorUrl('not a url')).toThrow(/not a valid/);
  });
});

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { StaticAgentTokenStore } from './static-agent-token-store.js';

describe('StaticAgentTokenStore', () => {
  it('createStatic returns a token with kat_ prefix and length 68', async () => {
    const store = new StaticAgentTokenStore();
    const result = await store.createStatic({ labels: ['linux'] });
    expect(result.token).toMatch(/^kat_[0-9a-f]{64}$/);
    expect(result.token.length).toBe(68);
    expect(typeof result.id).toBe('string');
  });

  it('validate returns valid for a freshly created static token', async () => {
    const store = new StaticAgentTokenStore();
    const { token } = await store.createStatic({});
    const result = await store.validate(token);
    expect(result).not.toBeNull();
    expect(result!.id).toBeDefined();
    expect(result!.agent_type).toBe('static');
  });

  it('validate returns null for unknown tokens', async () => {
    const store = new StaticAgentTokenStore();
    const result = await store.validate('kat_' + '00'.repeat(32));
    expect(result).toBeNull();
  });

  it('createEphemeral returns a token with TTL', async () => {
    const store = new StaticAgentTokenStore();
    const token = await store.createEphemeral('agent-1', ['linux'], 60_000);
    expect(token).toMatch(/^kat_[0-9a-f]{64}$/);
  });

  it('validate returns null for expired ephemeral tokens', async () => {
    const store = new StaticAgentTokenStore();

    // Create an ephemeral token with 1ms TTL
    const token = await store.createEphemeral('agent-1', ['linux'], 1);

    // Wait for expiry
    await new Promise((r) => setTimeout(r, 10));

    const result = await store.validate(token);
    expect(result).toBeNull();
  });

  it('revoke removes a token', async () => {
    const store = new StaticAgentTokenStore();
    const { token, id } = await store.createStatic({});

    const revoked = await store.revoke(id);
    expect(revoked).toBe(true);

    const result = await store.validate(token);
    expect(result).toBeNull();
  });

  it('revoke returns false for unknown token id', async () => {
    const store = new StaticAgentTokenStore();
    const revoked = await store.revoke('unknown-id');
    expect(revoked).toBe(false);
  });

  it('each generated token is unique', async () => {
    const store = new StaticAgentTokenStore();
    const tokens = new Set<string>();
    for (let i = 0; i < 10; i++) {
      const { token } = await store.createStatic({});
      tokens.add(token);
    }
    expect(tokens.size).toBe(10);
  });
});

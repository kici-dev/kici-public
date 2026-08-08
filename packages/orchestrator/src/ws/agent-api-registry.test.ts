import { describe, it, expect } from 'vitest';
import {
  AgentApiRegistry,
  ApiRoleDeniedError,
  UnknownApiMethodError,
} from './agent-api-registry.js';

describe('AgentApiRegistry', () => {
  it('registers and handles a read method', async () => {
    const registry = new AgentApiRegistry();
    registry.register('test.echo', 'read', async (_agentId, params) => params);

    const result = await registry.handle('agent-1', 'test.echo', { foo: 'bar' }, ['read']);
    expect(result).toEqual({ foo: 'bar' });
  });

  it('rejects unknown methods', async () => {
    const registry = new AgentApiRegistry();
    await expect(registry.handle('agent-1', 'nope', {}, ['read'])).rejects.toThrow(
      "Unknown API method 'nope'",
    );
  });

  it('rejects when caller lacks required role', async () => {
    const registry = new AgentApiRegistry();
    registry.register('admin.destroy', 'write', async () => 'destroyed');

    await expect(registry.handle('agent-1', 'admin.destroy', {}, ['read'])).rejects.toThrow(
      "requires 'write' role",
    );
  });

  it('allows when caller has the required role', async () => {
    const registry = new AgentApiRegistry();
    registry.register('admin.destroy', 'write', async () => 'destroyed');

    const result = await registry.handle('agent-1', 'admin.destroy', {}, ['read', 'write']);
    expect(result).toBe('destroyed');
  });

  it('throws on duplicate registration', () => {
    const registry = new AgentApiRegistry();
    registry.register('test.method', 'read', async () => null);
    expect(() => registry.register('test.method', 'read', async () => null)).toThrow(
      'already registered',
    );
  });

  it('passes agentId to handler', async () => {
    const registry = new AgentApiRegistry();
    registry.register('test.whoami', 'read', async (agentId) => ({ agentId }));

    const result = await registry.handle('my-agent', 'test.whoami', {}, ['read']);
    expect(result).toEqual({ agentId: 'my-agent' });
  });

  it('handles a write method when the agent dispatch grants read+write', async () => {
    // The agent-handler's agent.api.request dispatch grants ['read', 'write'] to
    // every agent (a write method only ever affects the calling agent's own
    // host, e.g. host.requestReboot). This documents that a write method is
    // reachable through the agent transport.
    const registry = new AgentApiRegistry();
    registry.register('host.requestReboot', 'write', async (agentId, params) => ({
      agentId,
      deadlineMs: params.deadlineMs,
    }));

    const result = await registry.handle('host-1', 'host.requestReboot', { deadlineMs: 600000 }, [
      'read',
      'write',
    ]);
    expect(result).toEqual({ agentId: 'host-1', deadlineMs: 600000 });
  });

  it('getMethods returns registered method names', () => {
    const registry = new AgentApiRegistry();
    registry.register('a.one', 'read', async () => null);
    registry.register('b.two', 'write', async () => null);

    expect(registry.getMethods()).toEqual(['a.one', 'b.two']);
  });

  describe('typed rejections', () => {
    // The two rejections the registry raises deliberately are typed so the agent
    // WS handler can forward their message verbatim, while any other exception
    // is replaced with a safe fixed string before it reaches the workflow author.
    it('rejects an unknown method with UnknownApiMethodError', async () => {
      const registry = new AgentApiRegistry();
      await expect(registry.handle('agent-1', 'nope', {}, ['read'])).rejects.toBeInstanceOf(
        UnknownApiMethodError,
      );
      await expect(registry.handle('agent-1', 'nope', {}, ['read'])).rejects.toBeInstanceOf(Error);
      await expect(registry.handle('agent-1', 'nope', {}, ['read'])).rejects.toThrow(
        "Unknown API method 'nope'",
      );
    });

    it('rejects an unauthorized role with ApiRoleDeniedError', async () => {
      const registry = new AgentApiRegistry();
      registry.register('admin.destroy', 'write', async () => 'destroyed');

      await expect(
        registry.handle('agent-1', 'admin.destroy', {}, ['read']),
      ).rejects.toBeInstanceOf(ApiRoleDeniedError);
      await expect(registry.handle('agent-1', 'admin.destroy', {}, ['read'])).rejects.toThrow(
        "Method 'admin.destroy' requires 'write' role, caller only has [read]",
      );
    });

    it('leaves a handler exception as a plain Error', async () => {
      const registry = new AgentApiRegistry();
      registry.register('test.boom', 'read', async () => {
        throw new Error('connect ECONNREFUSED 10.0.0.7:5432');
      });

      const err = await registry.handle('agent-1', 'test.boom', {}, ['read']).catch((e) => e);
      expect(err).toBeInstanceOf(Error);
      expect(err).not.toBeInstanceOf(UnknownApiMethodError);
      expect(err).not.toBeInstanceOf(ApiRoleDeniedError);
    });
  });
});

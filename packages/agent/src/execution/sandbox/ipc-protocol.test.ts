import { describe, it, expect } from 'vitest';
import type {
  CacheRequestIpc,
  CacheResponseIpc,
  CacheRequestOp,
  RunnerToAgentMessage,
  AgentToRunnerMessage,
} from './ipc-protocol.js';

describe('IPC protocol: CacheRequestIpc', () => {
  it('conforms to RunnerToAgentMessage union (restore op)', () => {
    const request: CacheRequestIpc = {
      type: 'cache.request',
      requestId: 'req-001',
      op: 'restore',
      key: 'deps-v1',
      restoreKeys: ['deps-'],
    };
    const msg: RunnerToAgentMessage = request;
    expect(msg.type).toBe('cache.request');
    expect((msg as CacheRequestIpc).op).toBe('restore');
  });

  it('supports the beginSave op', () => {
    const request: CacheRequestIpc = {
      type: 'cache.request',
      requestId: 'req-002',
      op: 'beginSave',
      key: 'deps-v1',
    };
    expect(request.op).toBe('beginSave');
  });

  it('supports the completeSave op with tarHash + sizeBytes', () => {
    const request: CacheRequestIpc = {
      type: 'cache.request',
      requestId: 'req-003',
      op: 'completeSave',
      key: 'deps-v1',
      tarHash: 'deadbeef',
      sizeBytes: 1234,
    };
    expect(request.tarHash).toBe('deadbeef');
    expect(request.sizeBytes).toBe(1234);
  });

  it('exposes the three op values via the CacheRequestOp type', () => {
    const ops: CacheRequestOp[] = ['restore', 'beginSave', 'completeSave'];
    expect(ops).toEqual(['restore', 'beginSave', 'completeSave']);
  });

  it('serializes and deserializes correctly via JSON', () => {
    const request: CacheRequestIpc = {
      type: 'cache.request',
      requestId: 'req-004',
      op: 'restore',
      key: 'k',
      restoreKeys: ['p-'],
    };
    const deserialized = JSON.parse(JSON.stringify(request)) as CacheRequestIpc;
    expect(deserialized.type).toBe('cache.request');
    expect(deserialized.op).toBe('restore');
    expect(deserialized.key).toBe('k');
    expect(deserialized.restoreKeys).toEqual(['p-']);
  });
});

describe('IPC protocol: CacheResponseIpc', () => {
  it('conforms to AgentToRunnerMessage union', () => {
    const response: CacheResponseIpc = {
      type: 'cache.response',
      requestId: 'req-001',
      hit: true,
      matchedKey: 'deps-v1',
      downloadUrl: 'https://s3.example.com/get',
      tarHash: 'deadbeef',
    };
    const msg: AgentToRunnerMessage = response;
    expect(msg.type).toBe('cache.response');
  });

  it('supports a save response (skip + uploadUrl)', () => {
    const response: CacheResponseIpc = {
      type: 'cache.response',
      requestId: 'req-002',
      skip: false,
      uploadUrl: 'https://s3.example.com/put',
    };
    expect(response.skip).toBe(false);
    expect(response.uploadUrl).toBe('https://s3.example.com/put');
  });

  it('supports an error response', () => {
    const response: CacheResponseIpc = {
      type: 'cache.response',
      requestId: 'req-003',
      error: 'cache backend unavailable',
    };
    expect(response.error).toBe('cache backend unavailable');
  });

  it('correlates requestId between request and response', () => {
    const request: CacheRequestIpc = {
      type: 'cache.request',
      requestId: 'corr-123',
      op: 'beginSave',
      key: 'k',
    };
    const response: CacheResponseIpc = {
      type: 'cache.response',
      requestId: 'corr-123',
      skip: true,
    };
    expect(response.requestId).toBe(request.requestId);
  });
});

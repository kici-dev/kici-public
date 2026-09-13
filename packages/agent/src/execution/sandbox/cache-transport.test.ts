import { describe, it, expect, vi } from 'vitest';
import { createCacheApi, type CacheTransport } from '../cache/index.js';
import type { CacheRequestIpc, CacheResponseIpc } from './ipc-protocol.js';

/**
 * Replica of the `buildCacheTransport` closure in workflow-runner.ts. The real
 * closure is module-private and depends on workflow-runner's module-level IPC
 * send + pending-response map; this replica injects those two seams so the
 * IPC-shape + correlation contract is testable in isolation. Keep it byte-for-byte
 * aligned with the workflow-runner implementation.
 */
function buildCacheTransport(
  sendIpc: (msg: CacheRequestIpc) => void,
  waitForResponse: (requestId: string) => Promise<CacheResponseIpc>,
  nextRequestId: () => string,
): CacheTransport {
  return {
    async restore(key, restoreKeys) {
      const requestId = nextRequestId();
      sendIpc({
        type: 'cache.request',
        requestId,
        op: 'restore',
        key,
        ...(restoreKeys && { restoreKeys }),
      });
      const response = await waitForResponse(requestId);
      if (response.error) throw new Error(`Cache restore failed: ${response.error}`);
      return {
        hit: response.hit ?? false,
        ...(response.matchedKey && { matchedKey: response.matchedKey }),
        ...(response.downloadUrl && { downloadUrl: response.downloadUrl }),
        ...(response.tarHash && { tarHash: response.tarHash }),
      };
    },
    async beginSave(key) {
      const requestId = nextRequestId();
      sendIpc({ type: 'cache.request', requestId, op: 'beginSave', key });
      const response = await waitForResponse(requestId);
      if (response.error) throw new Error(`Cache save failed: ${response.error}`);
      return {
        skip: response.skip ?? true,
        ...(response.uploadUrl && { uploadUrl: response.uploadUrl }),
      };
    },
    async completeSave(key, tarHash, sizeBytes) {
      const requestId = nextRequestId();
      sendIpc({ type: 'cache.request', requestId, op: 'completeSave', key, tarHash, sizeBytes });
      const response = await waitForResponse(requestId);
      if (response.error) throw new Error(`Cache save-complete failed: ${response.error}`);
    },
  };
}

describe('cache transport IPC mapping', () => {
  it('restore() issues a cache.request{op:restore} and maps the response', async () => {
    const sent: CacheRequestIpc[] = [];
    const transport = buildCacheTransport(
      (msg) => sent.push(msg),
      async () => ({
        type: 'cache.response',
        requestId: 'r1',
        hit: true,
        matchedKey: 'deps-v1',
        downloadUrl: 'https://s3/get',
        tarHash: 'deadbeef',
      }),
      () => 'r1',
    );

    const result = await transport.restore('deps-v1', ['deps-']);

    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      type: 'cache.request',
      op: 'restore',
      key: 'deps-v1',
      restoreKeys: ['deps-'],
    });
    expect(result).toEqual({
      hit: true,
      matchedKey: 'deps-v1',
      downloadUrl: 'https://s3/get',
      tarHash: 'deadbeef',
    });
  });

  it('restore() reports a miss when the orchestrator replies hit=false', async () => {
    const transport = buildCacheTransport(
      () => {},
      async () => ({ type: 'cache.response', requestId: 'r1', hit: false }),
      () => 'r1',
    );
    expect(await transport.restore('k')).toEqual({ hit: false });
  });

  it('beginSave() issues a cache.request{op:beginSave} and maps skip + uploadUrl', async () => {
    const sent: CacheRequestIpc[] = [];
    const transport = buildCacheTransport(
      (msg) => sent.push(msg),
      async () => ({
        type: 'cache.response',
        requestId: 'r1',
        skip: false,
        uploadUrl: 'https://s3/put',
      }),
      () => 'r1',
    );

    const result = await transport.beginSave('deps-v1');

    expect(sent[0]).toMatchObject({ type: 'cache.request', op: 'beginSave', key: 'deps-v1' });
    expect(result).toEqual({ skip: false, uploadUrl: 'https://s3/put' });
  });

  it('completeSave() issues a cache.request{op:completeSave} with tarHash + sizeBytes', async () => {
    const sent: CacheRequestIpc[] = [];
    const transport = buildCacheTransport(
      (msg) => sent.push(msg),
      async () => ({ type: 'cache.response', requestId: 'r1' }),
      () => 'r1',
    );

    await transport.completeSave('deps-v1', 'deadbeef', 4096);

    expect(sent[0]).toMatchObject({
      type: 'cache.request',
      op: 'completeSave',
      key: 'deps-v1',
      tarHash: 'deadbeef',
      sizeBytes: 4096,
    });
  });

  it('throws when the orchestrator returns an error response', async () => {
    const transport = buildCacheTransport(
      () => {},
      async () => ({ type: 'cache.response', requestId: 'r1', error: 'backend down' }),
      () => 'r1',
    );
    await expect(transport.restore('k')).rejects.toThrow(/backend down/);
  });
});

describe('createCacheApi over the IPC transport', () => {
  it('ctx.cache.save begins, then skips the upload + completeSave when the key exists', async () => {
    const transport: CacheTransport = {
      restore: vi.fn(),
      beginSave: vi.fn().mockResolvedValue({ skip: true }),
      completeSave: vi.fn(),
    };
    const api = createCacheApi('/tmp/work', transport);

    await api.save({ key: 'deps-v1', paths: ['node_modules'] });

    expect(transport.beginSave).toHaveBeenCalledWith('deps-v1');
    expect(transport.completeSave).not.toHaveBeenCalled();
  });

  it('ctx.cache.restore reports a miss when the transport returns hit=false', async () => {
    const transport: CacheTransport = {
      restore: vi.fn().mockResolvedValue({ hit: false }),
      beginSave: vi.fn(),
      completeSave: vi.fn(),
    };
    const api = createCacheApi('/tmp/work', transport);

    const result = await api.restore({ key: 'deps-v1', paths: ['node_modules'] });

    expect(transport.restore).toHaveBeenCalledWith('deps-v1', undefined);
    expect(result).toEqual({ hit: false });
  });
});

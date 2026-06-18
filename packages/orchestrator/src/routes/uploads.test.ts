import { describe, it, expect, vi } from 'vitest';
import { initTestUpload } from './uploads.js';

/** Build a chainable Kysely insert mock that records the inserted row. */
function mockDb() {
  const values = vi.fn().mockReturnThis();
  const execute = vi.fn().mockResolvedValue(undefined);
  const insertInto = vi.fn().mockReturnValue({ values, execute });
  return { db: { insertInto } as any, values, execute, insertInto };
}

describe('initTestUpload', () => {
  it('uses the external presign endpoint when internal is false', async () => {
    const { db, values } = mockDb();
    const getUploadUrl = vi.fn().mockResolvedValue('https://ext.example/put?sig=1');
    const getInternalUploadUrl = vi.fn().mockResolvedValue('https://int.example/put?sig=2');

    const result = await initTestUpload(
      { db, cacheStorage: { getUploadUrl, getInternalUploadUrl } as any },
      { routingKey: 'remote:org_1', sha: 'abc', internal: false },
    );

    expect(getUploadUrl).toHaveBeenCalledTimes(1);
    expect(getInternalUploadUrl).not.toHaveBeenCalled();
    expect(result.signedUrl).toBe('https://ext.example/put?sig=1');
    expect(result.uploadId).toBeTruthy();
    expect(result.publicKey).toBeTruthy();
    expect(result.expiresIn).toBe(3600);

    // The ephemeral private key + created_by are persisted on the row.
    const row = values.mock.calls[0][0];
    expect(row.routing_key).toBe('remote:org_1');
    expect(row.encryption_private_key).toBeTruthy();
    expect(row.status).toBe('pending');
  });

  it('uses the internal presign endpoint when internal is true', async () => {
    const { db } = mockDb();
    const getUploadUrl = vi.fn().mockResolvedValue('https://ext.example/put');
    const getInternalUploadUrl = vi.fn().mockResolvedValue('https://int.example/put');

    const result = await initTestUpload(
      { db, cacheStorage: { getUploadUrl, getInternalUploadUrl } as any },
      { routingKey: 'remote:org_1', internal: true },
    );

    expect(getInternalUploadUrl).toHaveBeenCalledTimes(1);
    expect(getUploadUrl).not.toHaveBeenCalled();
    expect(result.signedUrl).toBe('https://int.example/put');
  });

  it('records the createdBy actor on the upload row', async () => {
    const { db, values } = mockDb();
    await initTestUpload(
      {
        db,
        cacheStorage: {
          getUploadUrl: vi.fn().mockResolvedValue('u'),
          getInternalUploadUrl: vi.fn(),
        } as any,
      },
      { routingKey: 'remote:org_1', createdBy: 'user:sub-1', internal: false },
    );
    expect(values.mock.calls[0][0].created_by).toBe('user:sub-1');
  });
});

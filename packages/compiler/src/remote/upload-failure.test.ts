import { describe, it, expect } from 'vitest';
import { describeUploadFailure } from './upload-failure.js';

describe('describeUploadFailure', () => {
  it('names the origin and the S3 setting, never the signed query', () => {
    const url =
      'http://host.docker.internal:8333/kici-cache/x?X-Amz-Signature=abc&X-Amz-Credential=k';
    const err = describeUploadFailure(new Error(`fetch failed for ${url}`), url);
    expect(err.message).toContain('http://host.docker.internal:8333');
    expect(err.message).toContain('KICI_STORAGE_UPLOAD_ENDPOINT');
    // fails-when: the presigned credential is echoed into a terminal or a report bundle
    expect(err.message).not.toContain('X-Amz-Signature');
    expect(err.message).not.toContain('abc');
  });

  it('names the filesystem setting for a signed blob URL', () => {
    const url = 'http://127.0.0.1:4000/api/v1/cache/blob/test-uploads/x?sig=s';
    const err = describeUploadFailure(new Error('ECONNREFUSED'), url);
    expect(err.message).toContain('KICI_STORAGE_FS_BASE_URL');
    expect(err.message).not.toContain('sig=s');
  });

  it('keeps the cause', () => {
    const cause = new Error('boom');
    expect(describeUploadFailure(cause, 'http://h/x').cause).toBe(cause);
  });
});

import { describe, it, expect, vi } from 'vitest';
import {
  agentPackageHashKey,
  parseSha256Sidecar,
  presignAgentPackageDownload,
  agentPackageExists,
  type AgentPackageDownloadStorage,
} from './download.js';

const SHA = 'a'.repeat(64);

describe('agentPackageHashKey', () => {
  it('is the payload key with a .sha256 suffix', () => {
    expect(agentPackageHashKey('0.2.0', 'linux-x64')).toBe(
      'agent-packages/0.2.0/kici-agent-linux-x64.tar.gz.sha256',
    );
  });
});

describe('parseSha256Sidecar', () => {
  it('extracts the leading hex token from a sha256sum-style line', () => {
    expect(parseSha256Sidecar(`${SHA}  kici-agent-linux-x64.tar.gz\n`)).toBe(SHA);
  });
  it('returns null for a non-hex / empty sidecar', () => {
    expect(parseSha256Sidecar('   \n')).toBeNull();
    expect(parseSha256Sidecar('not-a-hash foo')).toBeNull();
  });
});

function stub(over: Partial<AgentPackageDownloadStorage> = {}): AgentPackageDownloadStorage {
  return {
    getUrl: vi.fn(async () => 'https://cache.local/presigned'),
    get: vi.fn(async () => Buffer.from(`${SHA}  kici-agent-linux-x64.tar.gz\n`)),
    has: vi.fn(async () => true),
    ...over,
  };
}

describe('presignAgentPackageDownload', () => {
  it('presigns the version-keyed payload key and reads its sha256', async () => {
    const storage = stub();
    const res = await presignAgentPackageDownload(storage, '1.2.3', 'linux-arm64');
    expect(res).toEqual({ url: 'https://cache.local/presigned', sha256: SHA });
    expect(storage.getUrl).toHaveBeenCalledWith(
      'agent-packages/1.2.3/kici-agent-linux-arm64.tar.gz',
    );
    expect(storage.get).toHaveBeenCalledWith(
      'agent-packages/1.2.3/kici-agent-linux-arm64.tar.gz.sha256',
    );
  });

  it('returns null when the payload object is absent (missing version)', async () => {
    const storage = stub({ getUrl: vi.fn(async () => null) });
    expect(await presignAgentPackageDownload(storage, '9.9.9', 'linux-x64')).toBeNull();
  });

  it('returns a null sha256 when no sidecar exists (caller fails closed)', async () => {
    const storage = stub({ get: vi.fn(async () => null) });
    const res = await presignAgentPackageDownload(storage, '1.2.3', 'linux-x64');
    expect(res).toEqual({ url: 'https://cache.local/presigned', sha256: null });
  });
});

describe('agentPackageExists', () => {
  it('delegates to has() on the version-keyed payload key', async () => {
    const storage = stub({ has: vi.fn(async () => false) });
    expect(await agentPackageExists(storage, '1.2.3', 'linux-x64')).toBe(false);
    expect(storage.has).toHaveBeenCalledWith('agent-packages/1.2.3/kici-agent-linux-x64.tar.gz');
  });
});

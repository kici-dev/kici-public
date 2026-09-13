import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { uploadAgentPackage, agentPackageKey } from './upload.js';

describe('agentPackageKey', () => {
  it('is version-keyed under the agent-packages prefix', () => {
    expect(agentPackageKey('0.2.0', 'linux-x64')).toBe(
      'agent-packages/0.2.0/kici-agent-linux-x64.tar.gz',
    );
    expect(agentPackageKey('0.2.0', 'linux-arm64')).toBe(
      'agent-packages/0.2.0/kici-agent-linux-arm64.tar.gz',
    );
  });
});

describe('uploadAgentPackage', () => {
  it('puts the tarball + sha256 under the version-keyed agent-packages prefix', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'up-'));
    const tarball = path.join(dir, 'kici-agent-linux-x64.tar.gz');
    writeFileSync(tarball, 'TARBYTES');
    const put = vi.fn(async () => {});
    const res = await uploadAgentPackage({ put }, '0.2.0', 'linux-x64', tarball, 'abc123');
    expect(res.key).toBe('agent-packages/0.2.0/kici-agent-linux-x64.tar.gz');
    expect(put).toHaveBeenCalledWith(
      'agent-packages/0.2.0/kici-agent-linux-x64.tar.gz',
      expect.any(Buffer),
    );
    expect(put).toHaveBeenCalledWith(
      'agent-packages/0.2.0/kici-agent-linux-x64.tar.gz.sha256',
      'abc123  kici-agent-linux-x64.tar.gz\n',
    );
  });
});

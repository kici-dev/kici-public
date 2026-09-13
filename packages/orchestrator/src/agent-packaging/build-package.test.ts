import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const installMock = vi.fn();
const nodeMock = vi.fn();
vi.mock('./install-closure.js', () => ({
  installAgentClosure: (...a: unknown[]) => installMock(...a),
}));
vi.mock('./node-binary.js', () => ({ downloadNodeBinary: (...a: unknown[]) => nodeMock(...a) }));

import { buildSelfContainedAgentPackage } from './build-package.js';

describe('buildSelfContainedAgentPackage', () => {
  it('installs the agent, vendors node, writes a launcher, tars + digests, version-keyed', async () => {
    const out = mkdtempSync(path.join(tmpdir(), 'pkg-'));
    // Simulate the npm install populating node_modules/@kici-dev/agent/dist/server.js.
    installMock.mockImplementation(async ({ prefixDir }: { prefixDir: string }) => {
      const d = path.join(prefixDir, 'node_modules', '@kici-dev', 'agent', 'dist');
      mkdirSync(d, { recursive: true });
      writeFileSync(path.join(d, 'server.js'), 'console.log("agent");');
    });
    nodeMock.mockImplementation(async ({ destBinPath }: { destBinPath: string }) => {
      mkdirSync(path.dirname(destBinPath), { recursive: true });
      writeFileSync(destBinPath, 'ELF');
    });

    const res = await buildSelfContainedAgentPackage({
      platform: 'linux-x64',
      version: '0.2.0',
      nodeVersion: '24.14.0',
      outDir: out,
    });

    // version-keyed path
    expect(res.tarballPath).toBe(path.join(out, '0.2.0', 'kici-agent-linux-x64.tar.gz'));
    expect(existsSync(res.tarballPath)).toBe(true);
    expect(existsSync(`${res.tarballPath}.sha256`)).toBe(true);
    expect(res.sha256).toMatch(/^[0-9a-f]{64}$/);
    // sha256 sidecar content matches
    expect(readFileSync(`${res.tarballPath}.sha256`, 'utf-8')).toContain(res.sha256);
    // install + node called for the right platform/version
    expect(installMock).toHaveBeenCalledWith(
      expect.objectContaining({ version: '0.2.0', platform: 'linux-x64' }),
    );
    expect(nodeMock).toHaveBeenCalledWith(
      expect.objectContaining({ version: '24.14.0', platform: 'linux-x64' }),
    );
  });
});

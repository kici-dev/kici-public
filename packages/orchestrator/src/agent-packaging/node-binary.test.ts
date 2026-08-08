import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const tarMock = vi.fn();
vi.mock('zx', () => ({
  // `$.sync(opts)` returns a template-tag function that runs the command.
  $: Object.assign(() => {}, {
    sync:
      (..._a: unknown[]) =>
      () =>
        tarMock(),
  }),
}));

import { downloadNodeBinary } from './node-binary.js';

describe('downloadNodeBinary', () => {
  const tarball = Buffer.from('fake-node-tarball');
  const hash = createHash('sha256').update(tarball).digest('hex');

  beforeEach(() => {
    tarMock.mockReset();
    globalThis.fetch = vi.fn(async (url: string) => {
      if (url.endsWith('SHASUMS256.txt')) {
        return new Response(`${hash}  node-v24.14.0-linux-x64.tar.gz\n`);
      }
      return new Response(tarball);
    }) as unknown as typeof fetch;
  });

  it('verifies sha256 and extracts the node binary + vendored npm', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'nb-'));
    const dest = path.join(dir, 'bin', 'node');
    const npmCli = path.join(dir, 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js');
    tarMock.mockImplementation(() => {
      // Model the real tar extraction: node binary + the bundled npm package.
      mkdirSync(path.dirname(dest), { recursive: true });
      writeFileSync(dest, 'x');
      mkdirSync(path.dirname(npmCli), { recursive: true });
      writeFileSync(npmCli, '#!/usr/bin/env node');
      return { exitCode: 0 };
    });
    await downloadNodeBinary({ version: '24.14.0', platform: 'linux-x64', destBinPath: dest });
    expect(existsSync(dest)).toBe(true);
    expect(existsSync(npmCli)).toBe(true);
  });

  it('throws when the vendored npm is missing after extract', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'nb-'));
    const dest = path.join(dir, 'bin', 'node');
    tarMock.mockImplementation(() => {
      // Only node lands — npm was not extracted.
      mkdirSync(path.dirname(dest), { recursive: true });
      writeFileSync(dest, 'x');
      return { exitCode: 0 };
    });
    await expect(
      downloadNodeBinary({ version: '24.14.0', platform: 'linux-x64', destBinPath: dest }),
    ).rejects.toThrow(/Vendored npm missing/);
  });

  it('throws on a sha256 mismatch', async () => {
    globalThis.fetch = vi.fn(async (url: string) =>
      url.endsWith('SHASUMS256.txt')
        ? new Response(`deadbeef  node-v24.14.0-linux-x64.tar.gz\n`)
        : new Response(tarball),
    ) as unknown as typeof fetch;
    const dir = mkdtempSync(path.join(tmpdir(), 'nb-'));
    await expect(
      downloadNodeBinary({
        version: '24.14.0',
        platform: 'linux-x64',
        destBinPath: path.join(dir, 'node'),
      }),
    ).rejects.toThrow(/SHA-256 mismatch/);
  });
});

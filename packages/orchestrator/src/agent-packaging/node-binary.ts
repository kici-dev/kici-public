import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync, chmodSync, rmSync, existsSync } from 'node:fs';
import path from 'node:path';
import { $ } from 'zx';
import { splitAgentPlatform, type AgentPlatform } from '@kici-dev/shared';

export interface DownloadNodeOptions {
  version: string;
  platform: AgentPlatform;
  /** Absolute path the verified `node` executable is written to. */
  destBinPath: string;
  /** Overrides https://nodejs.org/dist (air-gap mirror). */
  nodeMirror?: string;
}

/**
 * Download + SHASUMS256-verify the Node runtime for a glibc-Linux platform and
 * vendor `node` + `npm` into the payload.
 *
 * Fetches the release's SHASUMS256.txt, finds the entry for the target
 * platform's `.tar.gz`, downloads the archive, verifies its sha256 against that
 * entry, and extracts the runtime into `<prefix>/` (where `<prefix>` is the
 * grandparent of `destBinPath`): the `node` binary at `<prefix>/bin/node`, the
 * `bin/npm` + `bin/npx` launcher symlinks, and the bundled npm package under
 * `<prefix>/lib/node_modules/npm`. npm is required so the booted agent can
 * install a workflow's `.kici/` dependencies on a box with no system Node —
 * `resolveNpm()` finds it at `<nodeDir>/../lib/node_modules/npm/bin/npm-cli.js`.
 * The vendored Node is what the produced payload boots on — no system Node is
 * ever used.
 */
export async function downloadNodeBinary(opts: DownloadNodeOptions): Promise<void> {
  const { nodeOs, nodeArch } = splitAgentPlatform(opts.platform);
  const base = (opts.nodeMirror ?? 'https://nodejs.org/dist').replace(/\/$/, '');
  const filename = `node-v${opts.version}-${nodeOs}-${nodeArch}.tar.gz`;
  const dir = `v${opts.version}`;

  const shaResp = await fetch(`${base}/${dir}/SHASUMS256.txt`);
  if (!shaResp.ok) throw new Error(`Failed to fetch SHASUMS256.txt: ${shaResp.status}`);
  const shaLine = (await shaResp.text()).split('\n').find((l) => l.endsWith(filename));
  if (!shaLine) throw new Error(`No SHA-256 entry for ${filename} in SHASUMS256.txt`);
  const expected = shaLine.trim().split(/\s+/)[0];

  const archiveResp = await fetch(`${base}/${dir}/${filename}`);
  if (!archiveResp.ok) throw new Error(`Failed to download ${filename}: ${archiveResp.status}`);
  const buf = Buffer.from(await archiveResp.arrayBuffer());
  const actual = createHash('sha256').update(buf).digest('hex');
  if (actual !== expected) {
    throw new Error(
      `SHA-256 mismatch for ${filename}:\n  expected ${expected}\n  actual   ${actual}`,
    );
  }

  // Extract into the payload prefix (grandparent of `<prefix>/bin/node`), so the
  // dist layout — bin/{node,npm,npx} + lib/node_modules/npm — lands verbatim and
  // `resolveNpm()`'s `<nodeDir>/../lib/node_modules/npm` lookup resolves.
  const prefixDir = path.dirname(path.dirname(opts.destBinPath));
  mkdirSync(prefixDir, { recursive: true });
  const archivePath = path.join(prefixDir, filename);
  writeFileSync(archivePath, buf);
  const inner = `node-v${opts.version}-${nodeOs}-${nodeArch}`;
  const members = [
    `${inner}/bin/node`,
    `${inner}/bin/npm`,
    `${inner}/bin/npx`,
    `${inner}/lib/node_modules/npm`,
  ];
  const out = $.sync({
    nothrow: true,
    stdio: 'pipe',
  })`tar -xzf ${archivePath} -C ${prefixDir} --strip-components=1 ${members}`;
  rmSync(archivePath, { force: true });
  if (out.exitCode !== 0) throw new Error(`Node runtime extraction failed: ${out.stderr}`);
  if (!existsSync(opts.destBinPath)) {
    throw new Error(`Node binary missing after extract: ${opts.destBinPath}`);
  }
  const npmCli = path.join(prefixDir, 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js');
  if (!existsSync(npmCli)) {
    throw new Error(`Vendored npm missing after extract: ${npmCli}`);
  }
  chmodSync(opts.destBinPath, 0o755);
}

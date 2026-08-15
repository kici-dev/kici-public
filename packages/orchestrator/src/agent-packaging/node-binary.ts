import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync, chmodSync, rmSync, existsSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import path from 'node:path';
import { $ } from 'zx';
import { splitAgentPlatform, serializeError, type AgentPlatform } from '@kici-dev/shared';

export interface DownloadNodeOptions {
  version: string;
  platform: AgentPlatform;
  /** Absolute path the verified `node` executable is written to. */
  destBinPath: string;
  /** Overrides https://nodejs.org/dist (air-gap mirror). */
  nodeMirror?: string;
}

/**
 * Fetch a Node dist URL, retrying transient failures. The runtime download is a
 * bootstrap-critical step on a box that may have flaky egress (a fresh customer
 * host, a CDN blip); a single bare `fetch` turns any transient connect/DNS/5xx
 * hiccup into an opaque `fetch failed` that aborts the whole packaging run. We
 * retry connection-level throws and 5xx responses with exponential backoff, and
 * fold the underlying `cause` (e.g. `connect ETIMEDOUT …`, `UND_ERR_…`) into the
 * final error so a genuine failure is diagnosable instead of a bare message.
 */
async function fetchNodeDist(url: string, attempts = 4): Promise<Response> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const resp = await fetch(url);
      if (resp.ok) return resp;
      // Retry transient upstream errors; a 4xx is deterministic — fail fast.
      if (resp.status < 500 || attempt === attempts) {
        throw new Error(`Failed to fetch ${url}: HTTP ${resp.status}`);
      }
      lastErr = new Error(`HTTP ${resp.status}`);
    } catch (err) {
      lastErr = err;
      if (attempt === attempts) {
        throw new Error(
          `Failed to fetch ${url} after ${attempts} attempts: ${JSON.stringify(serializeError(err))}`,
        );
      }
    }
    await sleep(Math.min(500 * 2 ** (attempt - 1), 4000));
  }
  // Unreachable: the loop either returns or throws on the final attempt.
  throw new Error(`Failed to fetch ${url}: ${JSON.stringify(serializeError(lastErr))}`);
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

  const shaResp = await fetchNodeDist(`${base}/${dir}/SHASUMS256.txt`);
  const shaLine = (await shaResp.text()).split('\n').find((l) => l.endsWith(filename));
  if (!shaLine) throw new Error(`No SHA-256 entry for ${filename} in SHASUMS256.txt`);
  const expected = shaLine.trim().split(/\s+/)[0];

  const archiveResp = await fetchNodeDist(`${base}/${dir}/${filename}`);
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

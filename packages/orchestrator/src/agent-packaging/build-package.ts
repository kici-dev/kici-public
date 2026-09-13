import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync, chmodSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { $ } from 'zx';
import type { AgentPlatform } from '@kici-dev/shared';
import { withTempDir } from '@kici-dev/shared/tmp';
import { installAgentClosure } from './install-closure.js';
import { downloadNodeBinary } from './node-binary.js';

export interface BuildAgentPackageOptions {
  platform: AgentPlatform;
  version: string;
  nodeVersion: string;
  outDir: string;
  nodeMirror?: string;
  npmRegistry?: string;
}
export interface AgentPackageResult {
  tarballPath: string;
  sha256: string;
}

/**
 * The launcher boots the payload on its VENDORED Node (`bin/node`) exclusively —
 * never a system Node. It runs the real installed agent's `server.js`, whose
 * transitive deps (workflow-runner companion, ts-loader hook, oxc binding)
 * resolve natively from the payload's own `node_modules`.
 */
const LAUNCHER = `#!/bin/sh
exec "$(dirname "$0")/bin/node" "$(dirname "$0")/node_modules/@kici-dev/agent/dist/server.js" "$@"
`;

/** Package the installed @kici-dev/agent + a vendored Node + npm into a self-contained tarball. */
export async function buildSelfContainedAgentPackage(
  opts: BuildAgentPackageOptions,
): Promise<AgentPackageResult> {
  // opts.platform is an AgentPlatform enum (`linux-x64` / `linux-arm64`), so it
  // always satisfies the allocator's `[a-z0-9-]+` label constraint.
  return withTempDir(`agent-pkg-${opts.platform}`, async (staging) => {
    await installAgentClosure({
      version: opts.version,
      platform: opts.platform,
      prefixDir: staging,
      npmRegistry: opts.npmRegistry,
    });
    await downloadNodeBinary({
      version: opts.nodeVersion,
      platform: opts.platform,
      destBinPath: path.join(staging, 'bin', 'node'),
      nodeMirror: opts.nodeMirror,
    });
    const launcher = path.join(staging, 'kici-agent');
    writeFileSync(launcher, LAUNCHER);
    chmodSync(launcher, 0o755);

    const versionDir = path.join(opts.outDir, opts.version);
    mkdirSync(versionDir, { recursive: true });
    const tarballPath = path.join(versionDir, `kici-agent-${opts.platform}.tar.gz`);
    // Archive the staging dir's CONTENTS at the tarball root, so extraction into a
    // target dir yields bin/, kici-agent, node_modules/ directly (no wrapper dir).
    const out = $.sync({
      nothrow: true,
      stdio: 'pipe',
    })`tar -czf ${tarballPath} -C ${staging} .`;
    if (out.exitCode !== 0) throw new Error(`tar failed: ${out.stderr}`);

    const sha256 = createHash('sha256').update(readFileSync(tarballPath)).digest('hex');
    writeFileSync(`${tarballPath}.sha256`, `${sha256}  ${path.basename(tarballPath)}\n`);
    return { tarballPath, sha256 };
  });
}

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
 * Boots the payload on its VENDORED Node (`bin/node`), never a system Node, running the
 * installed agent's `server.js`; its transitive deps (workflow-runner companion, ts-loader
 * hook, oxc binding) resolve from the payload's own `node_modules`.
 */
const LAUNCHER = `#!/bin/sh
exec "$(dirname "$0")/bin/node" "$(dirname "$0")/node_modules/@kici-dev/agent/dist/server.js" "$@"
`;

/** Package the installed @kici-dev/agent + a vendored Node + npm into a self-contained tarball. */
export async function buildSelfContainedAgentPackage(
  opts: BuildAgentPackageOptions,
): Promise<AgentPackageResult> {
  // An AgentPlatform value always satisfies the allocator's `[a-z0-9-]+` label constraint.
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
    // Contents at the tarball root: extraction yields bin/, kici-agent,
    // node_modules/ directly (no wrapper dir).
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

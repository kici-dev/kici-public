/**
 * The official Node.js distribution a full KiCI package embeds: the archive to
 * download, the members to keep, the download cache that holds them, and how
 * they land in a package.
 *
 * A full package carries npm beside its Node binary, so an agent started from
 * it passes the builder role's npm check on a host with no npm. The agent's
 * `resolveNpm()` (packages/agent/src/execution/npm-resolver.ts) looks for
 * `<nodeDir>/../lib/node_modules/npm/bin/npm-cli.js`, then
 * `<nodeDir>/node_modules/npm/bin/npm-cli.js`. Each archive layout meets one of
 * them, so each is kept as it is:
 *
 * - Linux and macOS: `bin/node`, the `bin/npm` and `bin/npx` symlinks, and
 *   `lib/node_modules/npm`, placed at the package root beside `lib/<target>.cjs`.
 * - Windows: `node.exe`, the npm and npx launchers, and `node_modules/npm` side
 *   by side, placed under the package's `bin/`.
 *
 * The cache (`<cacheBase>/<os>-<arch>/`) holds exactly those members, in the
 * archive's own layout, and the archive's `LICENSE`, which a full package
 * carries as `NODE-LICENSE`. It is published with one rename, so a concurrent
 * packaging run sees either no cache or a complete one.
 */
import { createHash, randomBytes } from 'node:crypto';
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { $ } from 'zx';

/**
 * Members of a Linux or macOS archive, relative to its top directory. Kept
 * equal to `NODE_RUNTIME_MEMBERS` in
 * packages/orchestrator/src/agent-packaging/node-runtime-members.ts (the
 * `kici-admin agent package` payload); node-dist.test.ts pins the two.
 */
export const UNIX_NODE_MEMBERS = ['bin/node', 'bin/npm', 'bin/npx', 'lib/node_modules/npm'];

/** Members of a Windows zip, relative to its top directory. */
export const WINDOWS_NODE_MEMBERS = [
  'node.exe',
  'npm',
  'npm.cmd',
  'npm.ps1',
  'npx',
  'npx.cmd',
  'npx.ps1',
  'node_modules/npm',
];

/**
 * The license file at the top of every official Node.js archive. It covers the
 * runtime and the dependencies it bundles, npm included.
 */
export const NODE_DIST_LICENSE = 'LICENSE';

/**
 * The nodejs.org archive for a version and platform.
 *
 * @param {string} version e.g. `24.15.0`
 * @param {{ os: string, arch: string }} platform `os` is `linux`, `darwin` or `win`
 */
export function nodeDistArchive(version, platform) {
  const inner = `node-v${version}-${platform.os}-${platform.arch}`;
  const filename = `${inner}.${platform.os === 'win' ? 'zip' : 'tar.gz'}`;
  const base = `https://nodejs.org/dist/v${version}`;
  return { inner, filename, url: `${base}/${filename}`, shasumsUrl: `${base}/SHASUMS256.txt` };
}

/**
 * Where a platform's members sit, relative to the cache directory, and where
 * they go in a package.
 */
function layout(platform) {
  if (platform.os === 'win') {
    return {
      members: WINDOWS_NODE_MEMBERS,
      node: 'node.exe',
      npmCli: 'node_modules/npm/bin/npm-cli.js',
      packageDir: 'bin',
    };
  }
  return {
    members: UNIX_NODE_MEMBERS,
    node: 'bin/node',
    npmCli: 'lib/node_modules/npm/bin/npm-cli.js',
    packageDir: '.',
  };
}

/** True when `dir` holds every member for the platform, npm's CLI and the license included. */
export function isNodeDistComplete(dir, platform) {
  const { members, npmCli } = layout(platform);
  return [...members, npmCli, NODE_DIST_LICENSE].every((m) => existsSync(path.join(dir, m)));
}

/**
 * Extract a platform's members from a Node.js archive into a new directory
 * under `workDir`, and return that directory.
 *
 * Windows zips are read with Info-ZIP `unzip`; its absence is a named error.
 *
 * @param {object} opts
 * @param {string} opts.archivePath the downloaded archive
 * @param {string} opts.version the Node.js version the archive holds
 * @param {{ os: string, arch: string }} opts.platform
 * @param {string} opts.workDir a directory this call may create and fill
 * @param {Record<string, string>} [opts.env] environment for the extractor
 */
export function extractNodeDist({ archivePath, version, platform, workDir, env = process.env }) {
  const { inner, filename } = nodeDistArchive(version, platform);
  const { members } = layout(platform);
  const run = $.sync({ nothrow: true, quiet: true, env });
  mkdirSync(workDir, { recursive: true });

  let tree;
  if (platform.os === 'win') {
    // unzip has no --strip-components, so the members land under `inner/`. A
    // directory member is selected by its contents; unzip's `*` matches `/`.
    const patterns = [...members, NODE_DIST_LICENSE].map((m) =>
      m.includes('/') ? `${inner}/${m}/*` : `${inner}/${m}`,
    );
    const out = run`unzip -q -o ${archivePath} ${patterns} -d ${workDir}`;
    if (out.exitCode === 127) {
      throw new Error(
        `Extracting ${filename} needs the unzip command, which is not on PATH. ` +
          'Install unzip (Debian/Ubuntu: apt install unzip) and run the packaging again.',
      );
    }
    if (out.exitCode !== 0) {
      throw new Error(`unzip could not extract Node.js from ${filename}: ${out.stderr.trim()}`);
    }
    tree = path.join(workDir, inner);
  } else {
    tree = path.join(workDir, 'tree');
    mkdirSync(tree);
    const paths = [...members, NODE_DIST_LICENSE].map((m) => `${inner}/${m}`);
    const out = run`tar -xzf ${archivePath} -C ${tree} --strip-components=1 ${paths}`;
    if (out.exitCode !== 0) {
      throw new Error(`tar could not extract Node.js from ${filename}: ${out.stderr.trim()}`);
    }
  }

  if (!isNodeDistComplete(tree, platform)) {
    throw new Error(
      `${filename} lacks one of ${[...members, NODE_DIST_LICENSE].join(', ')}, or npm's bin/npm-cli.js`,
    );
  }
  chmodSync(path.join(tree, layout(platform).node), 0o755);
  return tree;
}

/**
 * Move an extracted tree into place as the cache directory.
 *
 * The tree is renamed in first, so a complete cache is never moved aside: the
 * rename fails only when a directory is already there. A complete one came
 * from a concurrent run, which is kept while this tree is dropped. An
 * incomplete one was left by an older packaging run (a bare `node` binary, no
 * npm, or no LICENSE); it is moved aside and the rename is tried again.
 */
export function publishNodeDist(tree, cacheDir, platform) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      renameSync(tree, cacheDir);
      return;
    } catch (err) {
      if (err.code !== 'ENOTEMPTY' && err.code !== 'EEXIST') throw err;
    }
    if (isNodeDistComplete(cacheDir, platform)) return;
    const stale = `${cacheDir}.stale-${process.pid}-${randomBytes(4).toString('hex')}`;
    try {
      renameSync(cacheDir, stale);
      rmSync(stale, { recursive: true, force: true });
    } catch (err) {
      // A concurrent run moved it first.
      if (err.code !== 'ENOENT') throw err;
    }
  }
  throw new Error(`Could not publish the Node.js cache at ${cacheDir}`);
}

/**
 * Return the cache directory holding the platform's Node.js runtime and npm,
 * downloading and SHA-256-verifying the official archive when the cache is
 * missing or incomplete.
 *
 * @param {object} opts
 * @param {string} opts.version
 * @param {{ os: string, arch: string }} opts.platform
 * @param {string} opts.cacheBase the per-version cache, e.g.
 *   `~/.cache/kici/node-binaries/v24.15.0`
 * @param {typeof fetch} [opts.fetch]
 * @param {(msg: string) => void} [opts.log]
 */
export async function ensureNodeDist({
  version,
  platform,
  cacheBase,
  fetch = globalThis.fetch,
  log = console.log,
}) {
  const cacheDir = path.join(cacheBase, `${platform.os}-${platform.arch}`);
  if (isNodeDistComplete(cacheDir, platform)) {
    log(`  [node] Cached: ${cacheDir}`);
    return cacheDir;
  }

  const { filename, url, shasumsUrl } = nodeDistArchive(version, platform);
  log(`  [node] Downloading SHASUMS256.txt for v${version}...`);
  const shaResp = await fetch(shasumsUrl);
  if (!shaResp.ok) {
    throw new Error(`Failed to download ${shasumsUrl}: ${shaResp.status} ${shaResp.statusText}`);
  }
  const shaLine = (await shaResp.text())
    .split('\n')
    .find((line) => line.trim().endsWith(`  ${filename}`));
  if (!shaLine) throw new Error(`No SHA-256 entry found for ${filename} in SHASUMS256.txt`);
  const expectedHash = shaLine.trim().split(/\s+/)[0];

  log(`  [node] Downloading ${url}...`);
  const archiveResp = await fetch(url);
  if (!archiveResp.ok) {
    throw new Error(`Failed to download ${url}: ${archiveResp.status} ${archiveResp.statusText}`);
  }
  const archive = Buffer.from(await archiveResp.arrayBuffer());
  const actualHash = createHash('sha256').update(archive).digest('hex');
  if (actualHash !== expectedHash) {
    throw new Error(
      `SHA-256 mismatch for ${filename}:\n  Expected: ${expectedHash}\n  Actual:   ${actualHash}`,
    );
  }
  log(`  [node] SHA-256 verified: ${actualHash.slice(0, 16)}...`);

  // The work directory sits beside the cache directory, so publishing it is a
  // rename within one filesystem.
  mkdirSync(cacheBase, { recursive: true });
  const workDir = mkdtempSync(path.join(cacheBase, `.extract-${platform.os}-${platform.arch}-`));
  try {
    const archivePath = path.join(workDir, filename);
    writeFileSync(archivePath, archive);
    const tree = extractNodeDist({
      archivePath,
      version,
      platform,
      workDir: path.join(workDir, 'x'),
    });
    publishNodeDist(tree, cacheDir, platform);
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
  log(`  [node] Cached: ${cacheDir} (Node.js v${version} with npm)`);
  return cacheDir;
}

/**
 * Copy the cached runtime into a package directory: the Unix members at the
 * package root, the Windows ones under `bin/`. Symlinks keep their relative
 * targets, so `bin/npm` still points at `../lib/node_modules/npm/bin/npm-cli.js`
 * inside the package.
 */
export function copyNodeDistIntoPackage(cacheDir, pkgDir, platform) {
  const { members, node, packageDir } = layout(platform);
  const dest = path.join(pkgDir, packageDir);
  for (const member of members) {
    const to = path.join(dest, member);
    mkdirSync(path.dirname(to), { recursive: true });
    cpSync(path.join(cacheDir, member), to, { recursive: true, verbatimSymlinks: true });
  }
  chmodSync(path.join(dest, node), 0o755);
}

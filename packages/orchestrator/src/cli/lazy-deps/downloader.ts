/**
 * Lazy dependency downloader: SHA-256-verified, extracted and cached for
 * offline use. An atomic rename keeps partial downloads out of the cache.
 *
 * A mirror (`KICI_LAZY_DEPS_MIRROR`, an `http(s)://` or `file://` base) replaces the
 * registry URL with `<mirror>/<name>/<version>/<platform>-<arch>/<file name>`. The registry's
 * SHA-256 is enforced on every source, so a mirror needs no trust: a substituted archive fails
 * the check.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sha256 } from '@kici-dev/shared';
import { LAZY_DEPS_MIRROR_ENV, lazyDepMirrorPath, type LazyDep } from '@kici-dev/shared/lazy-deps';

/** The mirror schemes a lazy dependency can be read from. */
const MIRROR_PROTOCOLS: ReadonlySet<string> = new Set(['http:', 'https:', 'file:']);

/**
 * The URL `dep` is downloaded from: its registry URL with no mirror, else its path under the
 * mirror. An empty mirror counts as none.
 * @throws If the mirror is not an `http(s)://` or `file://` URL.
 */
export function resolveDepUrl(dep: LazyDep, mirror: string | undefined): string {
  const base = mirror?.trim();
  if (!base) return dep.url;
  let parsed: URL;
  try {
    parsed = new URL(base);
  } catch {
    throw new Error(`${LAZY_DEPS_MIRROR_ENV} is not a URL: ${JSON.stringify(base)}`);
  }
  if (!MIRROR_PROTOCOLS.has(parsed.protocol)) {
    throw new Error(
      `${LAZY_DEPS_MIRROR_ENV} must be an http://, https:// or file:// URL, not ${parsed.protocol}`,
    );
  }
  return `${base.replace(/\/+$/, '')}/${lazyDepMirrorPath(dep)}`;
}

/** @throws If the SHA-256 hex digest does not match. */
export function verifyIntegrity(content: Buffer, expectedHash: string): void {
  const actualHash = sha256(content);
  if (actualHash !== expectedHash) {
    throw new Error(
      `SHA-256 integrity check failed.\n` +
        `  Expected: ${expectedHash}\n` +
        `  Actual:   ${actualHash}`,
    );
  }
}

async function downloadFile(url: string): Promise<Buffer> {
  if (url.startsWith('file:')) {
    const file = fileURLToPath(url);
    try {
      return fs.readFileSync(file);
    } catch (err) {
      throw new Error(
        `Read failed: ${(err as NodeJS.ErrnoException).code ?? 'error'} for ${file}`,
        {
          cause: err,
        },
      );
    }
  }
  const response = await fetch(url, { redirect: 'follow' });
  if (!response.ok) {
    throw new Error(`Download failed: ${response.status} ${response.statusText} from ${url}`);
  }
  const arrayBuffer = await response.arrayBuffer();
  return Buffer.from(arrayBuffer);
}

async function extractTarGz(archivePath: string, destDir: string): Promise<void> {
  const tar = await import('tar');
  await tar.extract({
    file: archivePath,
    cwd: destDir,
  });
}

/**
 * Windows extracts with `Expand-Archive`. Every other host reads the archive in-process, so a
 * host with no `unzip` (a minimal or air-gapped admin host) still caches a zip dependency.
 * @throws On an entry whose path leaves `destDir`.
 */
async function extractZip(archivePath: string, destDir: string): Promise<void> {
  if (process.platform === 'win32') {
    const { execSync } = await import('node:child_process');
    execSync(
      `powershell -Command "Expand-Archive -Path '${archivePath}' -DestinationPath '${destDir}' -Force"`,
      { stdio: 'ignore' },
    );
    return;
  }
  const { default: JSZip } = await import('jszip');
  const zip = await JSZip.loadAsync(fs.readFileSync(archivePath));
  const root = path.resolve(destDir);
  for (const entry of Object.values(zip.files)) {
    const target = path.resolve(root, entry.name);
    // fails-when: an entry named ../x is written outside the extract dir
    if (target !== root && !target.startsWith(root + path.sep)) {
      throw new Error(`zip entry leaves the extract dir: ${entry.name}`);
    }
    if (entry.dir) {
      fs.mkdirSync(target, { recursive: true });
      continue;
    }
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, await entry.async('nodebuffer'));
  }
}

/** Where {@link ensureDep} reads a lazy dependency from. */
export interface EnsureDepOptions {
  /** A mirror base URL; when absent, `KICI_LAZY_DEPS_MIRROR` is read. */
  mirror?: string;
}

/**
 * Return the cached path, downloading, verifying and extracting on a miss. The download comes
 * from the mirror when one is set ({@link resolveDepUrl}), and from the registry URL otherwise.
 */
export async function ensureDep(
  dep: LazyDep,
  cacheDir: string,
  opts: EnsureDepOptions = {},
): Promise<string> {
  const finalPath = path.join(cacheDir, dep.name, dep.version);

  if (fs.existsSync(finalPath)) {
    return finalPath;
  }

  fs.mkdirSync(cacheDir, { recursive: true });

  const tmpDir = path.join(cacheDir, `.tmp-${dep.name}-${Date.now()}`);
  fs.mkdirSync(tmpDir, { recursive: true });

  try {
    const url = resolveDepUrl(dep, opts.mirror ?? process.env[LAZY_DEPS_MIRROR_ENV]);
    console.log(
      `Downloading ${dep.name} v${dep.version} for ${dep.platform}-${dep.arch} from ${url}...`,
    );
    const content = await downloadFile(url);

    console.log(`Verifying SHA-256 integrity...`);
    verifyIntegrity(content, dep.sha256);

    const archiveExt =
      dep.archiveType === 'tar.gz' ? '.tar.gz' : dep.archiveType === 'zip' ? '.zip' : '';
    const archivePath = path.join(tmpDir, `archive${archiveExt}`);
    fs.writeFileSync(archivePath, content);

    console.log(`Extracting...`);
    const extractDir = path.join(tmpDir, 'extracted');
    fs.mkdirSync(extractDir, { recursive: true });

    if (dep.archiveType === 'tar.gz') {
      await extractTarGz(archivePath, extractDir);
    } else if (dep.archiveType === 'zip') {
      await extractZip(archivePath, extractDir);
    } else if (dep.archiveType === 'binary') {
      const destPath = path.join(extractDir, path.basename(dep.extractPath));
      fs.copyFileSync(archivePath, destPath);
      fs.chmodSync(destPath, 0o755);
    }

    // Atomic rename into the cache.
    const parentDir = path.dirname(finalPath);
    fs.mkdirSync(parentDir, { recursive: true });
    fs.renameSync(extractDir, finalPath);

    console.log(`Cached ${dep.name} v${dep.version} at ${finalPath}`);
    return finalPath;
  } finally {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // Best-effort cleanup
    }
  }
}

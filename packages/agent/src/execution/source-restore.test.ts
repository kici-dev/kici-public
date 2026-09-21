import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { c as tarCreate } from 'tar';
import { restoreSource } from './source-restore.js';

let workDir: string;
let packDir: string;

/** Pack a `.kici/` tree the same way the build agent's `packKiciSource` does. */
async function packTarball(files: Record<string, string>): Promise<{ file: string; sha: string }> {
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(packDir, '.kici', rel);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, content);
  }
  const stream = tarCreate({ gzip: true, cwd: packDir, portable: true }, ['.kici']);
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk as Uint8Array));
  const data = Buffer.concat(chunks);
  const file = path.join(packDir, 'source.tar.gz');
  await fs.writeFile(file, data);
  return { file, sha: createHash('sha256').update(data).digest('hex') };
}

beforeEach(async () => {
  workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kici-restore-work-'));
  packDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kici-restore-pack-'));
});

afterEach(async () => {
  await fs.rm(workDir, { recursive: true, force: true });
  await fs.rm(packDir, { recursive: true, force: true });
});

describe('restoreSource', () => {
  it('installs the tarball tree at workDir/.kici', async () => {
    const { file, sha } = await packTarball({ 'workflows/w.ts': 'export default 1;\n' });
    await restoreSource(workDir, pathToFileURL(file).href, sha);
    expect(await fs.readFile(path.join(workDir, '.kici/workflows/w.ts'), 'utf-8')).toBe(
      'export default 1;\n',
    );
  });

  it('drops a file present in the clone but absent from the tarball', async () => {
    // The overlay defect: extracting over the existing tree left a helper the
    // author DELETED in place, so it kept being imported on every warm-cache run.
    await fs.mkdir(path.join(workDir, '.kici/lib'), { recursive: true });
    await fs.writeFile(path.join(workDir, '.kici/lib/stale.ts'), 'export const stale = 1;\n');
    const { file, sha } = await packTarball({ 'workflows/w.ts': 'export default 1;\n' });

    await restoreSource(workDir, pathToFileURL(file).href, sha);

    await expect(fs.access(path.join(workDir, '.kici/lib/stale.ts'))).rejects.toThrow();
    await expect(fs.access(path.join(workDir, '.kici/workflows/w.ts'))).resolves.toBeUndefined();
  });

  it('keeps a dependency tree the deps restore already wrote', async () => {
    // Every call path restores the deps tarball into `.kici/node_modules`
    // BEFORE the source tarball, and the source tarball omits that directory —
    // so replacing `.kici` wholesale would strand the workflow with no
    // `@kici-dev/sdk` to import, and the inline install that would repair it is
    // skipped exactly when a `depsUrl` was dispatched.
    const sdkIndex = path.join(workDir, '.kici/node_modules/@kici-dev/sdk/index.js');
    await fs.mkdir(path.dirname(sdkIndex), { recursive: true });
    await fs.writeFile(sdkIndex, 'export const sdk = 1;\n');
    const { file, sha } = await packTarball({ 'workflows/w.ts': 'export default 1;\n' });

    await restoreSource(workDir, pathToFileURL(file).href, sha);

    expect(await fs.readFile(sdkIndex, 'utf-8')).toBe('export const sdk = 1;\n');
    await expect(fs.access(path.join(workDir, '.kici/workflows/w.ts'))).resolves.toBeUndefined();
  });

  it('fails the run on a digest mismatch, before extracting anything', async () => {
    const { file } = await packTarball({ 'workflows/w.ts': 'export default 1;\n' });
    await expect(restoreSource(workDir, pathToFileURL(file).href, 'f'.repeat(64))).rejects.toThrow(
      /hash mismatch/,
    );
    await expect(fs.access(path.join(workDir, '.kici'))).rejects.toThrow();
  });

  it('restores unverified when no digest is dispatched', async () => {
    // A source that did not come from the content-addressed cache carries no
    // digest, so the restore proceeds unverified rather than failing the job.
    const { file } = await packTarball({ 'workflows/w.ts': 'export default 1;\n' });
    await restoreSource(workDir, pathToFileURL(file).href);
    await expect(fs.access(path.join(workDir, '.kici/workflows/w.ts'))).resolves.toBeUndefined();
  });

  it('leaves no scratch directory behind, on success or on failure', async () => {
    const { file, sha } = await packTarball({ 'workflows/w.ts': 'export default 1;\n' });
    await restoreSource(workDir, pathToFileURL(file).href, sha);
    await expect(
      restoreSource(workDir, pathToFileURL(file).href, '0'.repeat(64)),
    ).rejects.toThrow();
    const entries = await fs.readdir(workDir);
    expect(entries.filter((e) => e.startsWith('.kici.restore-'))).toEqual([]);
  });

  it('rejects an unsupported URL scheme', async () => {
    await expect(restoreSource(workDir, 'ftp://example.com/x.tar.gz')).rejects.toThrow(
      /Unsupported source tarball URL scheme/,
    );
  });
});

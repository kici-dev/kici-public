import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { c as tarCreate } from 'tar';
import { REPO_ANCHOR, HOME_ANCHOR } from '@kici-dev/core';
import { extractArtifactTarball, HOME_SUBDIR } from './artifact-extract.js';

const scratch: string[] = [];
afterEach(async () => {
  for (const d of scratch.splice(0)) await rm(d, { recursive: true, force: true });
});

/** Build a gzipped tarball whose keys are anchored paths relative to the tar root. */
async function makeAnchoredTarball(entries: Record<string, string>): Promise<Buffer> {
  const staging = await mkdtemp(join(tmpdir(), 'art-stage-'));
  scratch.push(staging);
  const tops = new Set<string>();
  for (const [p, body] of Object.entries(entries)) {
    const full = join(staging, p);
    await mkdir(join(full, '..'), { recursive: true });
    await writeFile(full, body);
    tops.add(p.split('/')[0]);
  }
  const chunks: Buffer[] = [];
  for await (const c of tarCreate({ gzip: true, portable: true, cwd: staging }, [...tops])) {
    chunks.push(Buffer.from(c as Uint8Array));
  }
  return Buffer.concat(chunks);
}

async function freshDest(): Promise<string> {
  const dest = await mkdtemp(join(tmpdir(), 'art-dest-'));
  scratch.push(dest);
  return dest;
}

describe('extractArtifactTarball', () => {
  it('relocates repo-anchored entries directly under destDir', async () => {
    const tarball = await makeAnchoredTarball({ [`${REPO_ANCHOR}/dist/app.js`]: 'hi' });
    const dest = await freshDest();
    await extractArtifactTarball(tarball, dest);
    expect(await readFile(join(dest, 'dist/app.js'), 'utf8')).toBe('hi');
    expect(await readdir(dest)).not.toContain(REPO_ANCHOR);
  });

  it('relocates home-anchored entries under the home sub-directory', async () => {
    const tarball = await makeAnchoredTarball({ [`${HOME_ANCHOR}/.cache/x`]: 'yo' });
    const dest = await freshDest();
    await extractArtifactTarball(tarball, dest);
    expect(await readFile(join(dest, HOME_SUBDIR, '.cache/x'), 'utf8')).toBe('yo');
    expect(await readdir(dest)).not.toContain(HOME_ANCHOR);
  });

  it('handles both anchor groups in one tarball without collision', async () => {
    const tarball = await makeAnchoredTarball({
      [`${REPO_ANCHOR}/out/a`]: 'A',
      [`${HOME_ANCHOR}/out/a`]: 'B',
    });
    const dest = await freshDest();
    await extractArtifactTarball(tarball, dest);
    expect(await readFile(join(dest, 'out/a'), 'utf8')).toBe('A');
    expect(await readFile(join(dest, HOME_SUBDIR, 'out/a'), 'utf8')).toBe('B');
  });

  it('creates the destination directory when it does not exist', async () => {
    const tarball = await makeAnchoredTarball({ [`${REPO_ANCHOR}/f`]: 'F' });
    const parent = await freshDest();
    const dest = join(parent, 'nested', 'bundle');
    await extractArtifactTarball(tarball, dest);
    expect(await readFile(join(dest, 'f'), 'utf8')).toBe('F');
  });

  it('keeps an unanchored top-level entry verbatim', async () => {
    const tarball = await makeAnchoredTarball({ 'loose/file': 'L' });
    const dest = await freshDest();
    await extractArtifactTarball(tarball, dest);
    expect(await readFile(join(dest, 'loose/file'), 'utf8')).toBe('L');
  });

  it('does not write outside destDir for a traversal-shaped entry name', async () => {
    // `tar` strips leading `../` segments on extract, so an escaping entry lands
    // inside the scratch dir and is relocated under destDir like any other.
    const tarball = await makeAnchoredTarball({ [`${REPO_ANCHOR}/sub/../esc`]: 'E' });
    const dest = await freshDest();
    await extractArtifactTarball(tarball, dest);
    const entries = await readdir(dest);
    expect(entries.length).toBeGreaterThan(0);
    expect(entries).not.toContain('..');
  });
});

/**
 * Files the remote workspace gets in place of the developer's bytes, matching a default-config
 * checkout on the agent. The developer's git may store a file unlike its working tree
 * (`core.autocrlf` or `eol` turn CRLF into LF; `core.fileMode=false` keeps HEAD's executable
 * bit), while a Linux checkout writes the blob's bytes and mode. A path with a configured filter
 * driver (Git LFS) keeps the developer's bytes: a checkout would write the pointer.
 */

import { spawnSync } from 'node:child_process';
import { constants } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { HermeticGit } from './hermetic-git.js';

/** The git modes of a regular file, the only entries whose bytes git converts. */
enum FileMode {
  Regular = '100644',
  Executable = '100755',
}

interface TreeEntry {
  mode: string;
  oid: string;
}

/** Every entry of `commit`'s tree, by path. */
function treeEntries(git: HermeticGit, ship: string, commit: string): Map<string, TreeEntry> {
  const out = new Map<string, TreeEntry>();
  for (const line of git
    .run(['ls-tree', '-r', '-z', '--full-tree', commit], { cwd: ship })
    .split('\0')) {
    const tab = line.indexOf('\t');
    if (tab < 0) continue;
    const [mode, , oid] = line.slice(0, tab).split(' ');
    out.set(line.slice(tab + 1), { mode, oid });
  }
  return out;
}

/** The blob id of each file's raw bytes, with no conversion. */
function rawObjectIds(git: HermeticGit, ship: string, repoRoot: string, paths: string[]): string[] {
  const gitDir = `--git-dir=${path.join(ship, '.git')}`;
  // `--stdin-paths` reads one path per line, so a name with a newline is hashed on its own.
  const batch = paths.filter((p) => !p.includes('\n'));
  const batchIds = batch.length
    ? git
        .run([gitDir, 'hash-object', '--no-filters', '--stdin-paths'], {
          cwd: repoRoot,
          input: `${batch.join('\n')}\n`,
        })
        .trim()
        .split('\n')
    : [];
  const ids = new Map(batch.map((p, i) => [p, batchIds[i]]));
  return paths.map(
    (p) =>
      ids.get(p) ??
      git.run([gitDir, 'hash-object', '--no-filters', '--', p], { cwd: repoRoot }).trim(),
  );
}

/** The paths whose `filter` attribute names a driver the developer configured. */
function developerFiltered(repoRoot: string, paths: string[]): Set<string> {
  if (paths.length === 0) return new Set();
  const read = (args: string[], input?: string) =>
    spawnSync('git', ['-C', repoRoot, ...args], {
      encoding: 'utf8',
      input,
      maxBuffer: 256 * 1024 * 1024,
    });
  const config = read(['config', '--name-only', '--get-regexp', '^filter\\..+\\.(clean|process)$']);
  // Exit 1: no filter driver is configured.
  if (config.status === 1) return new Set();
  const drivers = new Set(
    config.stdout
      .split('\n')
      .filter(Boolean)
      .map((key) => key.slice('filter.'.length, key.lastIndexOf('.'))),
  );
  const attrs = read(['check-attr', '--stdin', '-z', 'filter'], `${paths.join('\0')}\0`);
  if (config.status !== 0 || attrs.status !== 0) {
    // Guessing here would ship a filtered file's pointer in place of its content.
    throw new Error(
      `Could not read the filter drivers of ${repoRoot}: ${(config.stderr || attrs.stderr).trim()}`,
    );
  }
  const fields = attrs.stdout.split('\0');
  const filtered = new Set<string>();
  // Output is `<path> NUL filter NUL <value> NUL` per path.
  for (let i = 0; i + 2 < fields.length; i += 3) {
    if (drivers.has(fields[i + 2])) filtered.add(fields[i]);
  }
  return filtered;
}

async function isExecutable(file: string): Promise<boolean> {
  return ((await fs.stat(file)).mode & constants.S_IXUSR) !== 0;
}

/**
 * Write under `outDir` each candidate whose default-config checkout differs from the working
 * tree in bytes or executable bit, by `git checkout-index` from the shipped index (so
 * `.gitattributes` applies).
 *
 * @returns the paths written, repo-relative
 */
export async function writeCheckoutBytes(
  git: HermeticGit,
  args: {
    ship: string;
    repoRoot: string;
    workspaceSha: string;
    /** Shipped paths whose content `workspaceSha` holds. */
    candidates: readonly string[];
    outDir: string;
  },
): Promise<string[]> {
  const tree = treeEntries(git, args.ship, args.workspaceSha);
  const files: string[] = [];
  for (const p of args.candidates) {
    const entry = tree.get(p);
    if (entry?.mode !== FileMode.Regular && entry?.mode !== FileMode.Executable) continue;
    const stat = await fs.lstat(path.join(args.repoRoot, p)).catch(() => undefined);
    if (stat?.isFile()) files.push(p);
  }
  const rawIds = rawObjectIds(git, args.ship, args.repoRoot, files);
  const differ: string[] = [];
  for (const [i, p] of files.entries()) {
    const entry = tree.get(p) as TreeEntry;
    const executable = await isExecutable(path.join(args.repoRoot, p));
    if (rawIds[i] !== entry.oid || executable !== (entry.mode === FileMode.Executable)) {
      differ.push(p);
    }
  }
  const filtered = developerFiltered(args.repoRoot, differ);
  const toWrite = differ.filter((p) => !filtered.has(p));
  if (toWrite.length === 0) return [];

  await fs.mkdir(args.outDir, { recursive: true });
  git.run(
    [
      `--git-dir=${path.join(args.ship, '.git')}`,
      `--work-tree=${args.outDir}`,
      'checkout-index',
      '-f',
      '-z',
      '--stdin',
    ],
    {
      cwd: args.outDir,
      env: { GIT_INDEX_FILE: path.join(args.ship, '.git', 'index') },
      input: `${toWrite.join('\0')}\0`,
    },
  );
  const written: string[] = [];
  for (const p of toWrite) {
    const out = path.join(args.outDir, p);
    const raw = path.join(args.repoRoot, p);
    const same =
      (await isExecutable(out)) === (await isExecutable(raw)) &&
      (await fs.readFile(out)).equals(await fs.readFile(raw));
    if (same) await fs.rm(out);
    else written.push(p);
  }
  return written;
}

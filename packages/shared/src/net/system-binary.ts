/**
 * Resolve an administrative binary (`nft`, `sysctl`, `iptables`) to the path a
 * spawn should run.
 *
 * Debian and most other distributions install these under `/usr/sbin`, which a
 * non-root process's PATH usually leaves out: a systemd user service, an SSH
 * session, or a shell started from either. Spawning the bare name there fails
 * with `ENOENT` although the binary is installed, and the failure reads as a
 * missing package rather than as a PATH gap.
 */

import { accessSync, constants, statSync } from 'node:fs';
import path from 'node:path';

/** The directories searched after PATH, in order. */
export const SYSTEM_BINARY_DIRS: readonly string[] = ['/usr/local/sbin', '/usr/sbin', '/sbin'];

export interface ResolveSystemBinaryOptions {
  /** The PATH to search first. Defaults to `process.env.PATH`. */
  pathEnv?: string;
  /** Whether `file` is an executable regular file. */
  isExecutable?: (file: string) => boolean;
}

function isExecutableFile(file: string): boolean {
  try {
    accessSync(file, constants.X_OK);
    return statSync(file).isFile();
  } catch {
    return false;
  }
}

/**
 * The first executable `name` on PATH, then in {@link SYSTEM_BINARY_DIRS}. A
 * name that already contains a slash is returned unchanged. When nothing is
 * found the bare name is returned, so the spawn still fails with `ENOENT` and
 * the caller's missing-binary handling still applies.
 */
export function resolveSystemBinary(name: string, opts: ResolveSystemBinaryOptions = {}): string {
  if (name.includes('/')) return name;
  const isExecutable = opts.isExecutable ?? isExecutableFile;
  const pathDirs = (opts.pathEnv ?? process.env.PATH ?? '')
    .split(path.delimiter)
    .filter((dir) => dir.length > 0);
  for (const dir of [...pathDirs, ...SYSTEM_BINARY_DIRS]) {
    const candidate = path.join(dir, name);
    if (isExecutable(candidate)) return candidate;
  }
  return name;
}

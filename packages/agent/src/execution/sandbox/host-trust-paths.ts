/**
 * TLS trust settings a job inherits from the agent host (`GIT_SSL_CAINFO`,
 * `SSL_CERT_FILE`, …) name files on the host. A job with its own filesystem —
 * a job container, a bubblewrap sandbox — sees them only through a read-only
 * mount. Each host path mounts under `TRUST_MOUNT_ROOT`, never at its own
 * location, so a host path like `/etc/ssl/certs/ca-certificates.crt` does not
 * hide the image's own trust store, and the setting is rewritten to the mount.
 */

import { realpathSync, statSync } from 'node:fs';
import { basename, isAbsolute, posix } from 'node:path';
import { TLS_TRUST_PATH_VARS } from '@kici-dev/engine';

/** The directory inside the job's filesystem that holds the host trust mounts. */
export const TRUST_MOUNT_ROOT = '/run/kici/trust';

/** The mount name when the resolved path has no usable last component. */
const FALLBACK_MOUNT_NAME = 'trust';

/** Settings that name a directory of certificates, not a bundle file. */
const DIRECTORY_VARS: ReadonlySet<string> = new Set(['SSL_CERT_DIR', 'GIT_SSL_CAPATH']);
/** OpenSSL reads `SSL_CERT_DIR` as a colon-separated list of directories. */
const DIRECTORY_LIST_VARS: ReadonlySet<string> = new Set(['SSL_CERT_DIR']);

/**
 * The TLS trust settings in `env` whose value came from the agent host, not
 * the job. A value the job, its source or its org sets (`jobSuppliedKeys`)
 * names a path in the job's own filesystem and is left alone.
 */
export function hostSuppliedTrustPaths(
  env: Record<string, string>,
  jobSuppliedKeys: ReadonlySet<string>,
  hostEnv: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const trustPaths: Record<string, string> = {};
  for (const key of TLS_TRUST_PATH_VARS) {
    const value = env[key];
    if (!value || jobSuppliedKeys.has(key) || value !== hostEnv[key]) continue;
    trustPaths[key] = value;
  }
  return trustPaths;
}

type TrustPathKind = 'file' | 'directory';

/** A host path with symlinks resolved, and what it is. */
export interface InspectedTrustPath {
  realPath: string;
  kind: TrustPathKind | 'other';
}

/** A read-only mount of a host trust path into the job's filesystem. */
export interface TrustPathMount {
  /** The host path, with symlinks resolved. */
  source: string;
  /** The path inside the job's filesystem, under `TRUST_MOUNT_ROOT`. */
  target: string;
}

export interface TrustPathPlan {
  /** Each resolved host path once. */
  mounts: TrustPathMount[];
  /** The settings to give the job, rewritten to the in-job paths. */
  env: Record<string, string>;
  /** Settings with no usable path on the host: the job must not receive them. */
  unavailableKeys: string[];
}

/**
 * The name of a mount under its numbered directory: the resolved path's last
 * component, or a fixed name when that is empty, `.` or `..`, so a target
 * never collapses onto `TRUST_MOUNT_ROOT` itself.
 */
function mountName(realPath: string): string {
  const name = basename(realPath);
  return name === '' || name === '.' || name === '..' ? FALLBACK_MOUNT_NAME : name;
}

function inspectHostPath(path: string): InspectedTrustPath | undefined {
  try {
    const realPath = realpathSync(path);
    const stats = statSync(realPath);
    const kind = stats.isFile() ? 'file' : stats.isDirectory() ? 'directory' : 'other';
    return { realPath, kind };
  } catch {
    return undefined;
  }
}

/**
 * Plan the mounts for `hostTrustPaths`. A path is usable when it is absolute
 * and resolves to a regular file (a directory for `SSL_CERT_DIR` and
 * `GIT_SSL_CAPATH`), other than `/`. The mount source and its name come from
 * the resolved path, so a symlink swapped after planning cannot redirect it,
 * and a socket or device never mounts. A setting with no usable path is dropped, and the image's own trust
 * store stays in use.
 */
export function planTrustPathMounts(
  hostTrustPaths: Record<string, string>,
  inspect: (path: string) => InspectedTrustPath | undefined = inspectHostPath,
): TrustPathPlan {
  const mounts: TrustPathMount[] = [];
  const env: Record<string, string> = {};
  const unavailableKeys: string[] = [];
  for (const [key, value] of Object.entries(hostTrustPaths)) {
    const wantKind: TrustPathKind = DIRECTORY_VARS.has(key) ? 'directory' : 'file';
    const paths = DIRECTORY_LIST_VARS.has(key) ? value.split(':') : [value];
    const targets: string[] = [];
    for (const path of paths) {
      if (!path || !isAbsolute(path)) continue;
      const found = inspect(path);
      // A colon cannot appear in a container bind spec.
      if (!found || found.kind !== wantKind || `${found.realPath}${path}`.includes(':')) continue;
      // fails-when: the whole host root mounts into the job's filesystem
      if (found.realPath === '/') continue;
      let mount = mounts.find((m) => m.source === found.realPath);
      if (!mount) {
        mount = {
          source: found.realPath,
          target: posix.join(TRUST_MOUNT_ROOT, String(mounts.length), mountName(found.realPath)),
        };
        mounts.push(mount);
      }
      targets.push(mount.target);
    }
    if (targets.length === 0) {
      unavailableKeys.push(key);
      continue;
    }
    env[key] = targets.join(':');
  }
  return { mounts, env, unavailableKeys };
}

/** `env` with the plan's settings rewritten and its unavailable settings removed. */
export function applyTrustPathPlan(
  env: Record<string, string>,
  plan: TrustPathPlan,
): Record<string, string> {
  const result = { ...env, ...plan.env };
  for (const key of plan.unavailableKeys) delete result[key];
  return result;
}

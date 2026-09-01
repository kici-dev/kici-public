/**
 * The KiCI-provisioned runtime a container job executes with.
 *
 * A container job used to require the customer's image to ship Node (to run the
 * workflow runner) and git (to clone). That coupled every image a customer might
 * name to KiCI's own toolchain. Instead KiCI provisions its own runtime — a
 * pinned, official glibc-2.17 Node plus the runner bundle, both already inside
 * the published `kici-agent` image — and mounts it read-only at `/opt/kici`.
 * The image then needs only a glibc and a shell.
 *
 * This module is a pure descriptor on purpose: the container-runtime calls that
 * act on it live in the spawn helper, so the launch contract stays unit-testable
 * without a daemon.
 */

/** Architectures the published runtime covers. */
export type RuntimeArch = 'x64' | 'arm64';

/** Read-only mount point of the KiCI-provisioned runtime inside a job container. */
export const KICI_RUNTIME_MOUNT = '/opt/kici';

/** Mount point of the injected Node tree inside a job container. */
export const KICI_RUNTIME_NODE_DIR = `${KICI_RUNTIME_MOUNT}/node`;

/** The injected node executable. Absolute — never resolved from the image's PATH. */
export const KICI_RUNTIME_NODE = `${KICI_RUNTIME_NODE_DIR}/bin/node`;

/** How to materialize the runtime into a job container. */
export interface RuntimeSource {
  arch: RuntimeArch;
  /** Where the runtime lives inside the `kici-agent` image. */
  sourceImagePath: string;
  /** Where it is mounted inside the job container. */
  mountPath: string;
  /** Always read-only: a job must not be able to rewrite the runtime it runs under. */
  readOnly: true;
}

/**
 * Launch the runner with the injected node, never the image's own.
 *
 * The customer image is not required to ship Node, so a bare `node` would
 * resolve to nothing (or, worse, to an unrelated build).
 */
export function runnerLaunchArgv(runnerMountPath: string): string[] {
  return [KICI_RUNTIME_NODE, runnerMountPath];
}

const SUPPORTED_ARCHES: readonly RuntimeArch[] = ['x64', 'arm64'];

/**
 * Describe how to materialize `/opt/kici` for a job container on `arch`.
 *
 * Refuses an architecture the published runtime does not cover, rather than
 * mounting a foreign-architecture binary that surfaces mid-job as a confusing
 * `exec format error`.
 */
export function resolveRuntimeSource(arch: RuntimeArch): RuntimeSource {
  if (!SUPPORTED_ARCHES.includes(arch)) {
    throw new Error(
      `unsupported architecture for the KiCI runtime: '${arch}' ` +
        `(published for ${SUPPORTED_ARCHES.join(', ')})`,
    );
  }
  return {
    arch,
    sourceImagePath: KICI_RUNTIME_MOUNT,
    mountPath: KICI_RUNTIME_MOUNT,
    readOnly: true,
  };
}

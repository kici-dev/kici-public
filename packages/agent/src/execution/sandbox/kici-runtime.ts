/**
 * The KiCI-provisioned runtime a container job executes with: a pinned, official
 * glibc-2.17 Node plus the runner bundle, both inside the published
 * `kici-agent` image, mounted read-only at `/opt/kici`. A customer image then
 * needs only a glibc and a shell, not Node or git, so it is not coupled to
 * KiCI's toolchain.
 *
 * A pure descriptor on purpose: the container-runtime calls live in the spawn
 * helper, so the launch contract stays unit-testable without a daemon.
 */

export type RuntimeArch = 'x64' | 'arm64';

/** Read-only, inside a job container. */
export const KICI_RUNTIME_MOUNT = '/opt/kici';

export const KICI_RUNTIME_NODE_DIR = `${KICI_RUNTIME_MOUNT}/node`;

/** Absolute: never resolved from the image's PATH. */
export const KICI_RUNTIME_NODE = `${KICI_RUNTIME_NODE_DIR}/bin/node`;

export interface RuntimeSource {
  arch: RuntimeArch;
  /** Inside the `kici-agent` image. */
  sourceImagePath: string;
  mountPath: string;
  /** A job must not be able to rewrite the runtime it runs under. */
  readOnly: true;
}

/**
 * Launch the runner with the injected node, never the image's own: a bare
 * `node` resolves to nothing or, worse, to an unrelated build.
 */
export function runnerLaunchArgv(runnerMountPath: string): string[] {
  return [KICI_RUNTIME_NODE, runnerMountPath];
}

const SUPPORTED_ARCHES: readonly RuntimeArch[] = ['x64', 'arm64'];

/**
 * Refuses an architecture the published runtime does not cover, rather than
 * mounting a foreign binary that fails mid-job with a confusing
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

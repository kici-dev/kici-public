/**
 * Container-spawn primitives specific to the orchestrator's scaler backends.
 *
 * The runtime-injection half of this module (`pullImageIfMissing`,
 * `ensureRuntimeVolume`, `runtimeInjectBind`, `injectedAgentCommand`,
 * `runtimeVolumeName`, `RUNTIME_MOUNT`) now lives in
 * `@kici-dev/shared/container-runtime`, because the AGENT needs exactly the
 * same behaviour when it nests a job container. What stays here is the piece
 * only a scaler backend does: streaming a host workspace into a container it
 * just created.
 */

import { c as tarCreate } from 'tar';

/**
 * Stream a host directory into a container path.
 *
 * Used to populate a container-owned `/workspace` volume, which is a volume
 * rather than a host bind precisely so the host-uid vs container-uid conflict
 * disappears once `CapDrop: ALL` removes CAP_DAC_OVERRIDE — so the tree has to
 * be copied in rather than mounted.
 *
 * A failure is fatal to the spawn: swallowing it starts the job against an
 * empty workspace, which surfaces as a baffling "file not found" later.
 */
export async function copyTreeIntoContainer(
  container: { putArchive(stream: unknown, opts: { path: string }): Promise<unknown> },
  hostDir: string,
  containerPath: string,
): Promise<void> {
  try {
    // `portable` drops uid/gid and mtime noise so the archive lands owned by
    // the container user rather than replaying host ownership.
    const stream = tarCreate({ cwd: hostDir, portable: true }, ['.']);

    // The stream errors ASYNCHRONOUSLY (an unreadable or missing hostDir
    // surfaces after tarCreate has already returned), so without racing it the
    // failure escapes this try/catch as an unhandled exception and the spawn
    // proceeds against an empty workspace.
    const streamFailed = new Promise<never>((_, reject) => {
      stream.on('error', reject);
    });
    await Promise.race([container.putArchive(stream, { path: containerPath }), streamFailed]);
  } catch (err) {
    throw new Error(
      `Failed to copy ${hostDir} into the container at ${containerPath}: ` +
        `${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

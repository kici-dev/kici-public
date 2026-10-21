/**
 * Container-runtime primitives shared by every site that starts a container for
 * KiCI: the orchestrator's container scaler backend, its bare-metal backend in
 * container mode, and the AGENT's own job-container sandbox.
 *
 * They live in `@kici-dev/shared` because the agent needs the same runtime
 * injection: a customer's job image is no more likely to ship Node than the one
 * a scaler spawns. One copy keeps the volume key, the root-owned copy and the
 * self-verification from disagreeing.
 *
 * They are composable functions rather than one `spawnAgentContainer`, because
 * the create/start step is caller-specific (network isolation, labels, binds,
 * log capture) while the steps below are identical everywhere.
 *
 * `dockerode` is a TYPE-ONLY import: every function takes a built client, so
 * `@kici-dev/shared` does not depend on it at runtime.
 */

import { z } from 'zod';
import type Docker from 'dockerode';

/**
 * When to pull an image. Defined here because both the orchestrator and the
 * agent call `pullImageIfMissing`; the orchestrator's `scaler/types.ts`
 * re-exports it for the scaler config schema.
 */
export const ImagePullPolicy = z.enum(['Always', 'IfNotPresent', 'Never']);
export type ImagePullPolicy = z.infer<typeof ImagePullPolicy>;

/** Registry credentials in the shape a container runtime expects. */
export interface RegistryAuthconfig {
  username: string;
  password: string;
  serveraddress: string;
}

export interface PullImageOptions {
  docker: Docker;
  image: string;
  /** Absent means an anonymous pull. */
  authconfig?: RegistryAuthconfig | undefined;
  signal?: AbortSignal | undefined;
  /** Progress sink; callers surface this as a scaler event. */
  onProgress?: ((message: string) => void) | undefined;
  /**
   * When to pull. Defaults to `IfNotPresent`, which is right for KiCI's own
   * agent images (pinned and immutable, so re-pulling every spawn only storms
   * the registry). A label set on a moving tag sets `Always`.
   */
  pullPolicy?: ImagePullPolicy | undefined;
}

/**
 * Pull `image` per the pull policy; returns whether a pull ran. Without an
 * authconfig a private registry fails with a 401 that reads like a missing image.
 */
export async function pullImageIfMissing(opts: PullImageOptions): Promise<boolean> {
  const { docker, image, authconfig, signal } = opts;
  const policy = opts.pullPolicy ?? ImagePullPolicy.enum.IfNotPresent;

  // `Never`: the operator guarantees the image is present (air-gapped host, or a
  // locally built image with no registry).
  if (policy === ImagePullPolicy.enum.Never) return false;

  if (policy === ImagePullPolicy.enum.IfNotPresent) {
    try {
      await docker.getImage(image).inspect({ ...(signal ? { abortSignal: signal } : {}) } as never);
      return false;
    } catch {
      // Not present locally — pull below.
    }
  }

  // A spawn already past its deadline would otherwise start a long pull that
  // only unwinds on the next abortable await.
  if (signal?.aborted) throw signal.reason ?? new Error('container spawn aborted');

  opts.onProgress?.(`pulling image ${image}`);
  const stream = await docker.pull(image, {
    ...(signal ? { abortSignal: signal } : {}),
    ...(authconfig ? { authconfig } : {}),
  });
  await new Promise<void>((resolve, reject) => {
    docker.modem.followProgress(stream, (err: Error | null) => (err ? reject(err) : resolve()));
  });
  return true;
}

/** Read-only mount point of the KiCI-provisioned runtime inside a container. */
export const RUNTIME_MOUNT = '/opt/kici';

/** Read-only mount point of the injected Node tree inside a job container. */
export const RUNTIME_NODE_MOUNT = `${RUNTIME_MOUNT}/node`;

/**
 * Bind spec that injects the KiCI runtime into a container. Read-only is
 * load-bearing: a job that could rewrite the runtime would control the
 * interpreter every later step runs under.
 */
export function runtimeInjectBind(hostRuntimeDir: string): string {
  return `${hostRuntimeDir}:${RUNTIME_MOUNT}:ro`;
}

/**
 * Image label naming the init an agent image ships in its runtime tree. The
 * scalers start an agent inside a job's own image, which need not ship an init,
 * so the init comes from the injected runtime. An agent image without the label
 * has no init there, and its agent starts as PID 1.
 */
export const RUNTIME_INIT_LABEL = 'kici.runtime.init';

/** The inits an agent image can name in {@link RUNTIME_INIT_LABEL}. */
export const RuntimeInit = z.enum(['tini']);
export type RuntimeInit = z.infer<typeof RuntimeInit>;

/** The static tini the agent image ships in its runtime tree. */
export const RUNTIME_TINI_PATH = `${RUNTIME_MOUNT}/bin/tini`;

/**
 * The command prefix for each init. Typed by the enum, so a new member needs an
 * entry. `-s` keeps tini a reaper if the runtime puts its own init at PID 1.
 */
const RUNTIME_INIT_COMMANDS: Record<RuntimeInit, readonly string[]> = {
  [RuntimeInit.enum.tini]: [RUNTIME_TINI_PATH, '-s', '--'],
};

/**
 * The init command for an injected agent, from the agent image's labels. Empty
 * when the image names no init or an unknown one: that agent starts as PID 1
 * and says so in its startup log.
 */
export function runtimeInitCommand(labels: Record<string, string> | null | undefined): string[] {
  const init = RuntimeInit.safeParse(labels?.[RUNTIME_INIT_LABEL]);
  return init.success ? [...RUNTIME_INIT_COMMANDS[init.data]] : [];
}

/** The agent image's labels. Precondition: the image is present (the runtime volume came from it). */
export async function agentImageLabels(
  docker: Docker,
  agentImage: string,
): Promise<Record<string, string> | undefined> {
  const info = (await docker.getImage(agentImage).inspect()) as {
    Config?: { Labels?: Record<string, string> | null };
  };
  return info.Config?.Labels ?? undefined;
}

/**
 * The agent image's ID, or `null` when the image is absent or the inspect fails.
 * Identifies the exact agent build a scaler label set starts, so knowledge learnt
 * from one of its agents holds only while the ID is unchanged.
 */
export async function agentImageId(docker: Docker, agentImage: string): Promise<string | null> {
  try {
    const info = (await docker.getImage(agentImage).inspect()) as { Id?: unknown };
    return typeof info.Id === 'string' && info.Id.length > 0 ? info.Id : null;
  } catch {
    return null;
  }
}

/**
 * Command that starts the agent from the INJECTED runtime, under `init` (from
 * {@link runtimeInitCommand}) when the agent image ships one.
 *
 * Only meaningful when the runtime is mounted. Without this override a job image
 * starts its own default CMD, no agent registers, and the job waits forever.
 *
 * Absolute on both halves: the image need not ship Node, and the agent lives in
 * the runtime tree, not the image's own /app.
 */
export function injectedAgentCommand(init: readonly string[] = []): string[] {
  return [
    ...init,
    `${RUNTIME_MOUNT}/node/bin/node`,
    `${RUNTIME_MOUNT}/app/packages/agent/dist/server.js`,
  ];
}

/**
 * Which part of an agent image's `/opt/kici` tree a caller needs.
 *
 * - `all` — node PLUS the agent application, for a spawn that runs the AGENT
 *   ITSELF from the volume (the per-job-image topologies).
 * - `node` — the Node tree alone, mounted at `/opt/kici/node`, for an agent
 *   nesting a job container: the runner bundle is bind-mounted from that
 *   agent's OWN build, so runner and agent versions can never differ.
 *
 * Separate volumes, not one tree mounted twice: the sandbox binds its runner and
 * loader hook at fixed paths under `/opt/kici`, and mountpoints inside a
 * read-only mount cannot be created.
 */
export const RuntimeSubtree = z.enum(['all', 'node']);
export type RuntimeSubtree = z.infer<typeof RuntimeSubtree>;

/**
 * Name of the shared volume holding the KiCI runtime, keyed by image IDENTITY.
 *
 * Keyed by the image's content id, never its name:tag: a moving tag such as
 * `:latest` is rebuilt in place, and a name-keyed volume would silently reuse
 * the previous version's binaries — a reused volume from an older image can
 * leave the mounted runtime empty, so every spawned container fails to start.
 *
 * The subtree is in the name too: `all` and `node` volumes have different roots,
 * so sharing a name would mount a tree whose `bin/node` is one level off.
 */
export function runtimeVolumeName(
  imageId: string,
  subtree: RuntimeSubtree = RuntimeSubtree.enum.all,
): string {
  // `sha256:abc…` -> `abc…`; any other id shape is slugified the same way.
  const slug = imageId
    .replace(/^sha256:/, '')
    .replace(/[^a-zA-Z0-9_.-]/g, '-')
    .slice(0, 32);
  const infix = subtree === RuntimeSubtree.enum.node ? 'node-' : '';
  return `kici-runtime-${infix}${slug}`;
}

export interface EnsureRuntimeVolumeOptions {
  docker: Docker;
  /** The published kici-agent image, which carries /opt/kici. */
  agentImage: string;
  /** Which part of the tree to materialize. Defaults to the whole runtime. */
  subtree?: RuntimeSubtree | undefined;
  signal?: AbortSignal | undefined;
  onProgress?: ((message: string) => void) | undefined;
}

/** Where the populator and the marker probe mount the volume being filled. */
const RUNTIME_OUT = '/kici-runtime-out';

/**
 * Marker file proving the volume holds a COMPLETE runtime.
 *
 * Volume existence is not population: the volume is created before the copy, so
 * a concurrent caller's `inspect()` succeeds mid-fill and mounts a half-copied
 * tree (typically a zod ESM SyntaxError far from the cause). The marker is
 * written LAST, after the populator's `test -x` checks, so it only appears on a
 * verified tree.
 */
const RUNTIME_COMPLETE_MARKER = `${RUNTIME_OUT}/.kici-runtime-complete`;

/**
 * The self-verifying copy each subtree runs in the populator container.
 *
 * The verification is load-bearing: `cp -a` of an absent or empty source exits
 * 0, leaving an EMPTY volume, and the spawned container then dies at start with
 * no error near the cause. The completion marker must stay the LAST command in
 * both branches, so it never lands on an unverified tree.
 */
function populatorCommand(subtree: RuntimeSubtree): string {
  const out = RUNTIME_OUT;
  if (subtree === RuntimeSubtree.enum.node) {
    return (
      `set -e; cp -a ${RUNTIME_MOUNT}/node/. ${out}/; ` +
      `test -x ${out}/bin/node; ` +
      `touch ${RUNTIME_COMPLETE_MARKER}`
    );
  }
  return (
    `set -e; cp -a ${RUNTIME_MOUNT}/. ${out}/; ` +
    `test -x ${out}/node/bin/node; ` +
    `test -f ${out}/app/packages/agent/dist/server.js; ` +
    `touch ${RUNTIME_COMPLETE_MARKER}`
  );
}

/** What the populator container printed, for an error that has to explain itself. */
async function populatorOutput(container: Docker.Container): Promise<string> {
  try {
    const buf = (await container.logs({ stdout: true, stderr: true, tail: 20 })) as unknown;
    return Buffer.isBuffer(buf) ? buf.toString('utf-8').trim() : String(buf).trim();
  } catch {
    return '';
  }
}

/**
 * Materialize the KiCI runtime into a named volume that job containers mount.
 *
 * The runtime lives inside the `kici-agent` image, but a bind mount needs a HOST
 * path, and a containerized caller cannot assume /opt/kici exists on the host.
 * A named volume copied from the image works on bare metal and in a container.
 *
 * Idempotent: one volume per (agent image, subtree), reused. Returns the volume
 * name to mount.
 */
export async function ensureRuntimeVolume(opts: EnsureRuntimeVolumeOptions): Promise<string> {
  const { docker, agentImage, signal } = opts;
  const subtree = opts.subtree ?? RuntimeSubtree.enum.all;

  // Pull FIRST: the volume name derives from the image's content id.
  await pullImageIfMissing({ docker, image: agentImage, ...(signal ? { signal } : {}) });
  const inspected = (await docker.getImage(agentImage).inspect()) as { Id?: string };
  const imageId = inspected.Id ?? agentImage;
  const name = runtimeVolumeName(imageId, subtree);

  // One populate per volume per process: concurrent callers share the in-flight
  // promise, so none mounts a tree another caller is still writing.
  const inFlight = inFlightRuntimeVolumes.get(name);
  if (inFlight) return await inFlight;

  const populating = materializeRuntimeVolume({ ...opts, subtree, name }).finally(() => {
    // ALWAYS clear: a retained rejected promise would fail every later spawn of
    // this image forever.
    inFlightRuntimeVolumes.delete(name);
  });
  inFlightRuntimeVolumes.set(name, populating);
  return await populating;
}

/** Per-volume populate in flight right now, so concurrent callers share one. */
const inFlightRuntimeVolumes = new Map<string, Promise<string>>();

/**
 * Does this volume carry the completion marker?
 *
 * A short-lived container is the only way to read a named volume: the daemon
 * owns the mount and a containerized caller has no host path to stat. It mounts
 * like the populator (root, same bind) to see exactly what it wrote.
 *
 * Any failure reads as NOT populated: a redundant copy is cheap, mounting an
 * unverified volume is the bug.
 */
async function runtimeVolumeIsPopulated(args: {
  docker: Docker;
  name: string;
  agentImage: string;
}): Promise<boolean> {
  const { docker, name, agentImage } = args;
  let probe: Docker.Container | undefined;
  try {
    probe = await docker.createContainer({
      Image: agentImage,
      User: '0:0',
      Cmd: ['sh', '-c', `test -f ${RUNTIME_COMPLETE_MARKER}`],
      // Labelled for the orphan reaper: a kill between create and remove would
      // otherwise strand an unidentifiable container, on every spawn.
      Labels: { 'kici-managed': 'true' },
      HostConfig: { Binds: [`${name}:${RUNTIME_OUT}`], AutoRemove: false },
    });
    await probe.start();
    const result = (await probe.wait()) as { StatusCode?: number };
    return result.StatusCode === 0;
  } catch {
    return false;
  } finally {
    await probe?.remove({ force: true }).catch(() => undefined);
  }
}

/** Populate the volume, reusing it only when the marker proves it is complete. */
async function materializeRuntimeVolume(
  opts: EnsureRuntimeVolumeOptions & { subtree: RuntimeSubtree; name: string },
): Promise<string> {
  const { docker, agentImage, subtree, name } = opts;

  // An existing volume is probed, not trusted; a missing one skips the probe.
  const exists = await docker
    .getVolume(name)
    .inspect()
    .then(() => true)
    .catch(() => false);
  if (exists && (await runtimeVolumeIsPopulated({ docker, name, agentImage }))) {
    return name;
  }

  opts.onProgress?.(`materializing the KiCI runtime from ${agentImage}`);
  await docker.createVolume({ Name: name, Labels: { 'kici-managed': 'true' } });

  // A throwaway copy container. `cp -a` keeps the node binary's executable bits
  // (losing them surfaces as a confusing "permission denied").
  const populator = await docker.createContainer({
    Image: agentImage,
    // Root, explicitly: the agent image runs as `node` and a new named volume is
    // root-owned, so rootful docker fails the copy with a bare "exited 1"
    // (rootless podman maps the user and hides this). The populator runs no
    // customer code.
    User: '0:0',
    Cmd: ['sh', '-c', populatorCommand(subtree)],
    // Same reaper contract as the volume it fills.
    Labels: { 'kici-managed': 'true' },
    HostConfig: { Binds: [`${name}:${RUNTIME_OUT}`], AutoRemove: false },
  });
  // Dropping the populator releases its volume reference: the daemon refuses to
  // remove a volume any container (even a STOPPED one) references, so a reap
  // before the drop fails silently and leaks the volume. Runs once.
  let populatorDropped = false;
  const dropPopulator = async (): Promise<void> => {
    if (populatorDropped) return;
    populatorDropped = true;
    await populator.remove({ force: true }).catch(() => undefined);
  };

  try {
    await populator.start();
    const result = (await populator.wait()) as { StatusCode?: number };
    if (result.StatusCode !== 0) {
      const output = await populatorOutput(populator);
      // Carry the container's output: a bare "exited 1" does not say whether the
      // tree was missing, the volume unwritable, or the disk full.
      throw new Error(
        `runtime copy exited ${result.StatusCode ?? 'unknown'}` +
          (output ? `: ${output}` : ' with no output'),
      );
    }
  } catch (err) {
    // Remove the half-populated volume ONLY when it is this call's — BOTH
    // conditions below, not either one.
    //
    // The in-flight map cannot see other processes. Agents share a daemon, so
    // two can populate one volume name at once: the loser collides with the
    // winner ("Text file busy"), and removing then would yank the volume from a
    // populate about to succeed, which the daemon re-creates EMPTY at mount
    // time. The daemon's reference check is a partial guard: Docker and podman's
    // compat endpoint refuse the reap with 409 while the peer's populator is
    // registered, and `force` does not override that, but the refusal ends once
    // that container is gone — the window the marker covers. (The podman CLI's
    // `--force` destroys the holding containers; the compat API does not.)
    //
    // `exists` is a snapshot from BEFORE the copy, so it does not prove
    // ownership; the marker is re-read and a volume that now reads complete is
    // left alone.
    //
    // Leaving a volume this call did not create is free: the missing marker
    // stops anyone mounting it, and the next populate copies over it.
    await dropPopulator();
    if (!exists && !(await runtimeVolumeIsPopulated({ docker, name, agentImage }))) {
      await docker
        .getVolume(name)
        .remove({ force: true })
        .catch(() => undefined);
    }
    throw new Error(
      `Failed to materialize the KiCI runtime from ${agentImage}: ` +
        `${err instanceof Error ? err.message : String(err)}. ` +
        `The image must carry /opt/kici/node and /opt/kici/app.`,
    );
  } finally {
    await dropPopulator();
  }

  return name;
}

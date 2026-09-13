/**
 * Container-runtime primitives shared by every site that starts a container for
 * KiCI: the orchestrator's container scaler backend, its bare-metal backend in
 * container mode, and the AGENT's own job-container sandbox.
 *
 * They live in `@kici-dev/shared` rather than in the orchestrator because the
 * agent needs the same runtime injection: when an ordinary agent nests a job
 * container from a customer's image, that image is no more likely to ship Node
 * than the one a scaler spawns. Two copies of "materialize the KiCI runtime"
 * would be two chances to disagree on the parts that are easy to get wrong —
 * the volume key, the root-owned copy, and the self-verification.
 *
 * They are separate composable functions rather than one `spawnAgentContainer`
 * that owns the whole sequence, because the create/start step is genuinely
 * caller-specific — network isolation, label sets, bind lists and log capture
 * differ per caller — while the steps below are identical everywhere.
 *
 * `dockerode` is a TYPE-ONLY import here: every function takes an already-built
 * client, so `@kici-dev/shared` does not depend on it at runtime and a consumer
 * that never imports this module never pulls it in.
 */

import { z } from 'zod';
import type Docker from 'dockerode';

/**
 * When to pull an image.
 *
 * Defined here rather than in the orchestrator's scaler types because
 * `pullImageIfMissing` lives here and both the orchestrator and the agent call
 * it. The orchestrator's `scaler/types.ts` re-exports it, so the scaler config
 * schema and every operator-facing value stay exactly as they were.
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
 * Pull `image` according to the pull policy. Returns whether a pull ran.
 *
 * Authenticated when an authconfig is supplied — a private registry otherwise
 * fails the pull with a 401 that reads like a missing image.
 */
export async function pullImageIfMissing(opts: PullImageOptions): Promise<boolean> {
  const { docker, image, authconfig, signal } = opts;
  const policy = opts.pullPolicy ?? ImagePullPolicy.enum.IfNotPresent;

  // `Never` means the operator guarantees the image is already there — a pull
  // would defeat the point (an air-gapped host, or a locally-built image with
  // no registry to pull from).
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
 * Bind spec that injects the KiCI runtime into a container.
 *
 * Read-only is load-bearing: a job that could rewrite the runtime would control
 * the interpreter every later step runs under.
 */
export function runtimeInjectBind(hostRuntimeDir: string): string {
  return `${hostRuntimeDir}:${RUNTIME_MOUNT}:ro`;
}

/**
 * Command that starts the agent from the INJECTED runtime.
 *
 * Only meaningful when the runtime is mounted. A spawned job image has its own
 * default CMD — python's shell, a node REPL, whatever the customer's image
 * declares — so without overriding it the container starts that instead and no
 * agent ever registers. The job then waits for an agent that will never arrive.
 *
 * Absolute on both halves: the image is not required to ship Node, and the
 * agent lives inside the runtime tree rather than at the image's own /app.
 */
export function injectedAgentCommand(): string[] {
  return [`${RUNTIME_MOUNT}/node/bin/node`, `${RUNTIME_MOUNT}/app/packages/agent/dist/server.js`];
}

/**
 * Which part of an agent image's `/opt/kici` tree a caller needs.
 *
 * - `all` — node PLUS the agent application. What a spawn that runs the AGENT
 *   ITSELF out of the volume needs (the per-job-image topologies), because the
 *   entrypoint resolves inside the mounted tree.
 * - `node` — the Node tree alone, mounted at `/opt/kici/node`. What an agent
 *   nesting a job container needs: the runner bundle is bind-mounted from that
 *   agent's OWN build, so the runner and the agent driving it can never be two
 *   different versions.
 *
 * They are separate volumes rather than one tree mounted twice because the
 * sandbox binds its runner and loader hook at fixed paths under `/opt/kici`.
 * Mounting the whole tree read-only at `/opt/kici` would put those two binds
 * INSIDE a read-only mount, whose mountpoints cannot be created.
 */
export const RuntimeSubtree = z.enum(['all', 'node']);
export type RuntimeSubtree = z.infer<typeof RuntimeSubtree>;

/**
 * Name of the shared volume holding the KiCI runtime, keyed by image IDENTITY.
 *
 * Keyed by the image's content id, never its name:tag. A tag moves — `:stg`,
 * `:latest`, and every E2E tag are rebuilt in place — so a name-keyed volume is
 * reused after the image it was copied from has been replaced, which is exactly
 * the "silently reusing the previous version's binaries" failure this is
 * supposed to prevent. It bit: a volume populated from a pre-/opt/kici image was
 * reused after the rebuild, and every spawned container failed to start because
 * the runtime it mounted was empty.
 *
 * The subtree is part of the name for the same reason: an `all` volume and a
 * `node` volume have different roots, so sharing one name would mount a tree
 * whose `bin/node` is one level off.
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
 * Volume existence is not population. A volume is created before the copy runs,
 * so a concurrent caller's `inspect()` succeeds against a volume that is still
 * being filled, and it mounts a half-copied tree — which surfaces far from the
 * cause, typically as a zod ESM SyntaxError from a partially written module.
 * The marker is written LAST, after the populator's own `test -x` checks, so it
 * can only appear on a tree that already verified.
 */
const RUNTIME_COMPLETE_MARKER = `${RUNTIME_OUT}/.kici-runtime-complete`;

/**
 * The self-verifying copy each subtree runs in the populator container.
 *
 * The verification is not decoration. `cp -a` of an absent or empty source
 * exits 0, leaving an EMPTY volume — and the spawn then creates a container
 * whose runtime mount has no node, which dies at start with no error recorded
 * anywhere near the cause.
 *
 * The completion marker is the LAST command in both branches: written any
 * earlier it would land on a tree that has not been verified, which is the
 * exact failure it exists to prevent.
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
 * The runtime lives inside the `kici-agent` image, but a bind mount needs a
 * HOST path — and the orchestrator (or the agent) may itself be containerized,
 * so it cannot assume /opt/kici exists on the host filesystem. Copying the tree
 * out of the image into a named volume once, then mounting that volume, works
 * the same whether the caller runs on bare metal or in a container.
 *
 * Idempotent: the volume is created once per (agent image, subtree) and reused.
 * Returns the volume name to mount.
 */
export async function ensureRuntimeVolume(opts: EnsureRuntimeVolumeOptions): Promise<string> {
  const { docker, agentImage, signal } = opts;
  const subtree = opts.subtree ?? RuntimeSubtree.enum.all;

  // Pull FIRST: the volume name is derived from the image's content id, which
  // requires the image to be present.
  await pullImageIfMissing({ docker, image: agentImage, ...(signal ? { signal } : {}) });
  const inspected = (await docker.getImage(agentImage).inspect()) as { Id?: string };
  const imageId = inspected.Id ?? agentImage;
  const name = runtimeVolumeName(imageId, subtree);

  // One populate per volume, however many callers arrive at once. Two agents
  // spawning together used to both see "no such volume", both create it, and
  // both copy into the same mount — so the loser mounted a tree the winner was
  // still writing. Sharing the in-flight promise makes the second caller await
  // the first rather than race it.
  const inFlight = inFlightRuntimeVolumes.get(name);
  if (inFlight) return await inFlight;

  const populating = materializeRuntimeVolume({ ...opts, subtree, name }).finally(() => {
    // ALWAYS clear, settled either way: a retained rejected promise would make
    // every later spawn of this image fail forever — worse than the race.
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
 * A short-lived container is the only way to read a named volume's contents:
 * the daemon owns the mount, and the caller may itself be containerized, so
 * there is no host path to stat. Mounted the same way the populator mounts it
 * (root, same bind) so the probe sees exactly what the populator wrote.
 *
 * Any failure to answer reads as NOT populated. Repopulating a good volume
 * costs one redundant copy; mounting an unverified one is the bug.
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
      // Labelled so the orphan reaper can find it. This runs on every spawn, so
      // an unlabelled one strands a container nothing can identify if the
      // process is killed between create and remove.
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

  // Existence is not population, so an existing volume is probed rather than
  // trusted. Skip the probe entirely when there is no volume: there is nothing
  // to read, and starting a container to learn that wastes a spawn.
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

  // A throwaway container whose only job is to copy the tree out of the image
  // into the volume. `cp -a` preserves the executable bits the node binary
  // needs; losing those would surface as a confusing "permission denied".
  const populator = await docker.createContainer({
    Image: agentImage,
    // Root, explicitly. The agent image runs as `node`, and a freshly created
    // named volume is owned by root — so under rootful docker the copy fails
    // with a bare "exited 1" that says nothing about permissions. Rootless
    // podman maps the user and happens to work, which is exactly why this only
    // showed up on the docker executor. The populator runs no customer code:
    // it copies one tree and exits.
    User: '0:0',
    Cmd: ['sh', '-c', populatorCommand(subtree)],
    // Same reaper contract as the volume it fills.
    Labels: { 'kici-managed': 'true' },
    HostConfig: { Binds: [`${name}:${RUNTIME_OUT}`], AutoRemove: false },
  });
  // Dropping the populator is what releases its reference to the volume. The
  // daemon refuses to remove a volume any container still references — a
  // STOPPED one counts — so a reap attempted while the populator is still
  // registered fails and is swallowed, leaving the dead volume on disk to be
  // found later as a leak. Runs once, from whichever path reaches it first.
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
      // Carry the container's own output. Without it the failure reads only as
      // "exited 1", which says nothing about whether the tree was missing, the
      // volume unwritable, or the disk full — one full debugging session was
      // spent recovering exactly that.
      throw new Error(
        `runtime copy exited ${result.StatusCode ?? 'unknown'}` +
          (output ? `: ${output}` : ' with no output'),
      );
    }
  } catch (err) {
    // Remove the half-populated volume, but ONLY when it is this call's to
    // remove — which takes BOTH conditions below, not either one.
    //
    // The in-flight map serialises populates within a process; it cannot see
    // another one. Agents run one process each and share a daemon, so two of
    // them reach the same volume name concurrently: the loser finds no marker,
    // starts its own copy, and collides with the winner's ("Text file busy").
    // Removing there would yank the volume out from under a populate that is
    // about to succeed, and the winner would then return a name whose volume
    // the daemon re-creates EMPTY at mount time — a worse failure than the one
    // being cleaned up after. The daemon's own reference check is only a
    // partial guard: verified against both the Docker engine and podman's
    // compat endpoint, a reap is refused with 409 while the peer's populator is
    // still registered, and `force` does not override that — but the refusal
    // stops once that container is gone, which is the window the marker covers.
    // (The podman *CLI*'s `--force` does destroy the holding containers; the
    // compat API dockerode speaks does not.)
    //
    // `exists` alone does not establish ownership: it is a snapshot taken
    // BEFORE the copy, and the whole window between that snapshot and this
    // failure is time another process had to create the volume and fill it. So
    // the marker is re-read here, and a volume that now reads complete is left
    // alone whatever the snapshot said.
    //
    // Leaving a volume this call did not create costs nothing: the missing
    // marker already stops anyone mounting it, and the next successful
    // populate copies over it.
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

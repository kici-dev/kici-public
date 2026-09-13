/**
 * Capability label for hosts that can run containers.
 *
 * An operator may put this on a pool's label sets and on a container job's
 * `runsOn` to steer container work at hosts with a runtime. KiCI does NOT add
 * it automatically, and does not gate routing on it.
 *
 * **Why it is not automatic.** A container job needs a runtime on the host that
 * ends up running it, and the orchestrator does not know that: an agent runs on
 * its own machine, and whether that machine has docker or podman is the agent's
 * fact, not the orchestrator's. Probing the orchestrator's own filesystem
 * answers a different question — it was tried, and it stranded container jobs
 * that had been running fine, because the probe and the job ran in different
 * places.
 *
 * Doing this properly means the AGENT reporting the capability at registration,
 * alongside the `kici:os:*` / `kici:arch:*` facts it already self-reports. Until
 * then a mis-routed container job fails at the image preflight or a backend's
 * fail-fast, both of which name what is missing — a clear late error, rather
 * than a job that silently matches nothing and never runs.
 */
export const KICI_RUNTIME_DOCKER_LABEL = 'kici:runtime:docker';

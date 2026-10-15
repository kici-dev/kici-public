/**
 * Label for hosts that can run containers.
 *
 * The agent reports it at registration when it finds a Docker socket (and
 * `kici:runtime:podman` for a Podman one): a container runtime is the agent
 * machine's fact. Probing the orchestrator's own filesystem was tried and
 * stranded working container jobs, because the probe and the job ran in
 * different places.
 *
 * Routing (`canAgentRunJob`): a `container:` job reaches an agent only when that
 * agent was started for it, or reports `kici:runtime:docker` or
 * `kici:runtime:podman`. An older agent reports no runtime labels, so its
 * silence proves nothing; a job it cannot run fails with a message that names
 * the missing runtime.
 *
 * An operator may still put the label on a pool's label sets and on a container
 * job's `runsOn` to steer container work at hosts with a runtime.
 */
export const KICI_RUNTIME_DOCKER_LABEL = 'kici:runtime:docker';

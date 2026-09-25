/**
 * Label for hosts that can run containers.
 *
 * The agent reports it itself at registration when it finds a Docker socket,
 * alongside `kici:runtime:podman` for a Podman one and the `kici:os:*` /
 * `kici:arch:*` facts: whether a machine has a container runtime is that
 * machine's fact, not the orchestrator's. Probing the orchestrator's own
 * filesystem answers a different question — it was tried, and it stranded
 * container jobs that had been running fine, because the probe and the job ran
 * in different places.
 *
 * Routing gates on the reported label (`canAgentRunJob`): a `container:` job
 * reaches an agent only when that agent was started for it, or reports
 * `kici:runtime:docker` or `kici:runtime:podman`. For an operator's own agent
 * the gate applies from the release that reports runtime labels at all; an
 * older agent reports none, so its silence proves nothing and a job it cannot
 * run fails on it with a message that names the missing runtime.
 *
 * An operator may still put the label on a pool's label sets and on a container
 * job's `runsOn` to steer container work at hosts with a runtime.
 */
export const KICI_RUNTIME_DOCKER_LABEL = 'kici:runtime:docker';

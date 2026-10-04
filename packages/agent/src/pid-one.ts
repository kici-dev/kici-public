/**
 * The startup warning for an agent that is PID 1.
 *
 * PID 1 inherits every orphaned process, and Node never reaps a process it did
 * not spawn, so a step's orphans stay zombies and a killed step's process group
 * reads as alive. KiCI's images and Firecracker guests start the agent under
 * tini; an agent that still finds itself PID 1 was started some other way.
 */
export const PID_ONE_WARNING =
  'The agent is running as PID 1 with no init, so processes a step leaves behind are never reaped. ' +
  'Start it under an init such as tini, or pass --init to docker run.';

/** The warning for an agent with process id `pid`, or undefined when there is none. */
export function pidOneWarning(pid: number): string | undefined {
  return pid === 1 ? PID_ONE_WARNING : undefined;
}

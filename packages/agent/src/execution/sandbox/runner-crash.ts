/**
 * Diagnostics for a container runner that exited without sending
 * `job.complete`: the message the job fails with, built from the exec exit
 * code and the runner's last stdout / stderr lines.
 */

/** How many non-JSON stdout lines to keep for the crash message. */
export const MAX_RAW_STDOUT_LINES = 5;

/** Exit code a shell or container runtime reports for a command it cannot find. */
export const EXIT_COMMAND_NOT_FOUND = 127;

/**
 * Error text a container runtime writes when the exec's `argv[0]` is missing
 * from the image: Docker's `exec: "node": executable file not found in $PATH`,
 * or crun's `executable file \`node\` not found in $PATH`.
 */
const EXECUTABLE_NOT_FOUND = /executable file .*not found/i;

/** Inputs to {@link describeRunnerCrash}. */
export interface RunnerCrashInput {
  /** The job's container image. */
  image: string;
  /** Whether the runner ran on an injected KiCI runtime instead of the image's own `node`. */
  runtimeInjected: boolean;
  /** Exec exit code, or undefined when the runtime could not report one. */
  exitCode: number | null | undefined;
  /** Last non-JSON stdout lines. The container runtime writes an exec failure there. */
  stdoutTail: string[];
  /** Last stderr lines. */
  stderrTail: string[];
}

/**
 * Append `line` to `lines`, keeping at most `max` entries (oldest dropped).
 */
export function pushBounded(lines: string[], line: string, max: number): void {
  lines.push(line);
  if (lines.length > max) lines.shift();
}

/**
 * Whether the crash is the image's own `node` missing: only possible when no
 * runtime was injected, and recognized by the command-not-found exit code or
 * the runtime's not-found error text.
 */
export function isImageNodeMissing(input: RunnerCrashInput): boolean {
  if (input.runtimeInjected) return false;
  if (input.exitCode === EXIT_COMMAND_NOT_FOUND) return true;
  return [...input.stdoutTail, ...input.stderrTail].some((line) => EXECUTABLE_NOT_FOUND.test(line));
}

/**
 * Build the failure message for a runner that exited without `job.complete`.
 */
export function describeRunnerCrash(input: RunnerCrashInput): string {
  const exit =
    input.exitCode === null || input.exitCode === undefined
      ? 'unknown exit code'
      : `exit code ${input.exitCode}`;
  const output = [...input.stdoutTail, ...input.stderrTail].join('\n');
  const detail = output ? `\nRunner output:\n${output}` : '';

  if (isImageNodeMissing(input)) {
    return (
      `The container image '${input.image}' has no 'node' executable, and no KiCI runtime is ` +
      `configured to inject one (${exit}). Set KICI_RUNTIME_NODE_SOURCE or KICI_RUNTIME_IMAGE ` +
      `on the agent, or use an image that ships Node.${detail}`
    );
  }
  return `Workflow runner exited without sending job.complete (${exit}).${detail}`;
}

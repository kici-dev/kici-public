/**
 * The failure message for a container runner that exited without sending
 * `job.complete`, built from the exec exit code and its last stdout / stderr lines.
 */

/** Non-JSON stdout lines kept for the crash message. */
export const MAX_RAW_STDOUT_LINES = 5;

/** Exit code a shell or container runtime reports for a command it cannot find. */
export const EXIT_COMMAND_NOT_FOUND = 127;

/**
 * Error text a container runtime writes when the exec's `argv[0]` is missing
 * from the image: Docker's `exec: "node": executable file not found in $PATH`,
 * or crun's `executable file \`node\` not found in $PATH`.
 */
const EXECUTABLE_NOT_FOUND = /executable file .*not found/i;

export interface RunnerCrashInput {
  image: string;
  /** Whether the runner ran on an injected KiCI runtime instead of the image's own `node`. */
  runtimeInjected: boolean;
  /** Undefined when the runtime could not report one. */
  exitCode: number | null | undefined;
  /** Last non-JSON stdout lines. The container runtime writes an exec failure there. */
  stdoutTail: string[];
  stderrTail: string[];
}

/** Keeps at most `max` entries, dropping the oldest. */
export function pushBounded(lines: string[], line: string, max: number): void {
  lines.push(line);
  if (lines.length > max) lines.shift();
}

/**
 * The image's own `node` is missing: only possible with no injected runtime,
 * recognized by the command-not-found exit code or the not-found error text.
 */
export function isImageNodeMissing(input: RunnerCrashInput): boolean {
  if (input.runtimeInjected) return false;
  if (input.exitCode === EXIT_COMMAND_NOT_FOUND) return true;
  return [...input.stdoutTail, ...input.stderrTail].some((line) => EXECUTABLE_NOT_FOUND.test(line));
}

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

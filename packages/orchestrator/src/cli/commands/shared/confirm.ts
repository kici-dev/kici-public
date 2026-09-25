/**
 * Yes/no confirmation prompt for the `kici-admin` verbs that change or destroy
 * state unless the operator passes `--yes`.
 */
import { createInterface } from 'node:readline';

/** Message of the error raised when stdin ends before the operator answers. */
export const NO_CONFIRMATION_ANSWER =
  'no answer to the confirmation prompt: stdin closed before a line arrived. ' +
  'Pass --yes to run without the prompt.';

/** The streams the prompt writes to and reads from. */
export interface ConfirmIo {
  input: NodeJS.ReadableStream;
  output: NodeJS.WritableStream;
}

/**
 * Write `prompt` and read one line of answer.
 *
 * Resolves true when the line is `y` or `yes` (any case, surrounding spaces
 * ignored) and false for any other line. Rejects with
 * {@link NO_CONFIRMATION_ANSWER} when stdin ends before a line arrives, as it
 * does for a script, a cron job or a `< /dev/null` redirect. Resolving false
 * there would let a verb run without `--yes` exit 0 having done nothing, and
 * the script that ran it would read that as success.
 */
export function confirmPrompt(
  prompt: string,
  io: ConfirmIo = { input: process.stdin, output: process.stderr },
): Promise<boolean> {
  const rl = createInterface({ input: io.input, output: io.output });
  return new Promise((resolve, reject) => {
    let answered = false;
    const settle = (answer: string): void => {
      if (answered) return;
      answered = true;
      rl.close();
      const normalized = answer.trim().toLowerCase();
      resolve(normalized === 'y' || normalized === 'yes');
    };
    rl.once('close', () => {
      if (!answered) reject(new Error(NO_CONFIRMATION_ANSWER));
    });
    // A final answer with no trailing newline (`printf y | kici-admin …`)
    // arrives as a plain 'line' event when stdin ends, not through question().
    rl.once('line', settle);
    rl.question(prompt, settle);
  });
}

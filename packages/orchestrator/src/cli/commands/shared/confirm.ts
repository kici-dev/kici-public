/** Yes/no prompt for the state-changing `kici-admin` verbs run without `--yes`. */
import { createInterface } from 'node:readline';

/** Raised when stdin ends before an answer. */
export const NO_CONFIRMATION_ANSWER =
  'no answer to the confirmation prompt: stdin closed before a line arrived. ' +
  'Pass --yes to run without the prompt.';

export interface ConfirmIo {
  input: NodeJS.ReadableStream;
  output: NodeJS.WritableStream;
}

/**
 * True for a `y` / `yes` line (any case, trimmed), false for any other line.
 * Rejects with {@link NO_CONFIRMATION_ANSWER} when stdin ends first (a script,
 * cron or `< /dev/null`): resolving false would exit 0 having done nothing,
 * which the calling script reads as success.
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

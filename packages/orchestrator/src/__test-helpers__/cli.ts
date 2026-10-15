/**
 * The in-process Commander harness the `kici-admin` command tests share.
 */
import { Command } from 'commander';

export interface CliResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
}

export interface RunCliOptions {
  /** Also capture direct `process.stderr.write` calls, Commander's own error output included. */
  captureStderrWrite?: boolean;
  /** Record a Commander error: its message joins stderr and its exit code (default 1) is kept. */
  recordCommanderErrors?: boolean;
}

const EXIT_PREFIX = 'EXIT:';

/**
 * Run a Commander program in-process and capture what `console.log` and
 * `console.error` print. `process.exit` is trapped: the code is recorded and
 * the action stops there. A Commander error is swallowed, and Commander itself
 * has already written it to the real stderr unless an option captures it. Any
 * other error is re-thrown, so a crashing action fails the test.
 */
export async function runCli(
  register: (program: Command) => void,
  args: string[],
  options: RunCliOptions = {},
): Promise<CliResult> {
  const program = new Command();
  program.exitOverride();
  register(program);

  const stdout: string[] = [];
  const stderr: string[] = [];
  let exitCode: number | null = null;
  const { log, error } = console;
  const { exit } = process;
  const stderrWrite = process.stderr.write;

  console.log = (...a: unknown[]) => stdout.push(a.join(' '));
  console.error = (...a: unknown[]) => stderr.push(a.join(' '));
  if (options.captureStderrWrite) {
    process.stderr.write = ((msg: string | Uint8Array) => {
      stderr.push(
        typeof msg === 'string' ? msg.replace(/\n$/, '') : Buffer.from(msg).toString('utf8'),
      );
      return true;
    }) as never;
  }
  process.exit = ((code?: number) => {
    exitCode = code ?? 0;
    throw new Error(`${EXIT_PREFIX}${code}`);
  }) as never;

  try {
    await program.parseAsync(args, { from: 'user' });
  } catch (err) {
    const e = (err ?? {}) as { message?: unknown; code?: unknown; exitCode?: number };
    const isExit = typeof e.message === 'string' && e.message.startsWith(EXIT_PREFIX);
    const isCommander = typeof e.code === 'string' && e.code.startsWith('commander.');
    if (!isExit && !isCommander) throw err;
    if (!isExit && options.recordCommanderErrors) {
      exitCode = e.exitCode ?? 1;
      stderr.push(String(e.message));
    }
  } finally {
    console.log = log;
    console.error = error;
    process.exit = exit;
    if (options.captureStderrWrite) process.stderr.write = stderrWrite;
  }
  return { stdout: stdout.join('\n'), stderr: stderr.join('\n'), exitCode };
}

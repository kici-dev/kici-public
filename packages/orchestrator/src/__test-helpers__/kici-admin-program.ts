import { vi } from 'vitest';
import { buildProgram } from '../cli/kici-admin.js';

/**
 * Run the real kici-admin program on `argv` with the console silenced and
 * `process.exit` turned into a throw. Returns the first exit code (null when
 * the command never exits) and what it printed to stderr. The caller restores
 * the spies (`vi.restoreAllMocks()`).
 */
export async function runKiciAdminProgram(
  argv: string[],
): Promise<{ exitCode: number | null; stderr: string }> {
  const errors: string[] = [];
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    errors.push(args.join(' '));
  });
  const exits: number[] = [];
  vi.spyOn(process, 'exit').mockImplementation(((code = 0) => {
    exits.push(code);
    throw new Error('process.exit');
  }) as never);
  // An exit ends in the stubbed process.exit, which throws out of the action.
  await buildProgram()
    .parseAsync(argv, { from: 'user' })
    .catch(() => undefined);
  return { exitCode: exits[0] ?? null, stderr: errors.join('\n') };
}

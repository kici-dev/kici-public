import { describe, it, expect } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  COMMAND_STDERR_TAIL_CHARS,
  CommandError,
  stderrTail,
  toCommandError,
} from './command-error.js';

const execFileAsync = promisify(execFile);

/**
 * Run `sh -c <script>` for real and return the rejection converted by
 * `toCommandError`, labelled `test-command` so the script text never shows up
 * in the message.
 */
async function failingCommand(script: string, timeoutMs?: number): Promise<CommandError> {
  const startedAt = Date.now();
  try {
    await execFileAsync(
      'sh',
      ['-c', script],
      timeoutMs === undefined ? {} : { timeout: timeoutMs },
    );
  } catch (err) {
    return toCommandError(err, {
      command: 'test-command',
      ...(timeoutMs === undefined ? {} : { timeoutMs }),
      durationMs: Date.now() - startedAt,
    });
  }
  throw new Error(`expected \`${script}\` to fail`);
}

describe('toCommandError', () => {
  it('reports the exit code and stderr of a command that exits non-zero', async () => {
    const err = await failingCommand('echo "mkfs.ext4: Device or resource busy" >&2; exit 3');

    // fails-when: the stderr, the exit code, or the not-a-timeout flag is lost.
    expect(err).toBeInstanceOf(CommandError);
    expect(err.exitCode).toBe(3);
    expect(err.signal).toBeNull();
    expect(err.timedOut).toBe(false);
    expect(err.stderrTail).toBe('mkfs.ext4: Device or resource busy');
    expect(err.message).toContain('exited with code 3');
    expect(err.message).toContain('stderr: mkfs.ext4: Device or resource busy');
    // Node's own text repeats stderr; the converted message carries it once.
    expect(err.message.split('Device or resource busy')).toHaveLength(2);
  });

  it('flags a command the timeout option killed, even when it printed nothing', async () => {
    const err = await failingCommand('sleep 5', 200);

    // fails-when: a timeout kill reads as a plain failure, which is what the
    // bare `Command failed: <cmd>` text of a quiet tool looked like.
    expect(err.timedOut).toBe(true);
    expect(err.signal).toBe('SIGTERM');
    expect(err.exitCode).toBeNull();
    expect(err.stderrTail).toBe('');
    expect(err.durationMs).toBeGreaterThanOrEqual(150);
    expect(err.message).toContain('timed out: killed by SIGTERM');
    expect(err.message).toContain('(timeout 200 ms)');
    expect(err.message).toContain('stderr: (empty)');
  });

  it('keeps a timed-out command stderr', async () => {
    const err = await failingCommand('echo "still waiting on /dev/sda" >&2; sleep 5', 300);

    expect(err.timedOut).toBe(true);
    expect(err.stderrTail).toBe('still waiting on /dev/sda');
  });

  it('does not flag a command killed by a signal it sent itself as timed out', async () => {
    // breaks-if-wrong: only the timeout option may set `timedOut`.
    const err = await failingCommand('kill -KILL $$');

    expect(err.timedOut).toBe(false);
    expect(err.signal).toBe('SIGKILL');
    expect(err.message).toContain('was killed by SIGKILL');
  });

  it('reports a command that could not start with its errno', async () => {
    const startedAt = Date.now();
    let err: CommandError | undefined;
    try {
      await execFileAsync('kici-no-such-binary-for-command-error-test', []);
    } catch (e) {
      err = toCommandError(e, {
        command: 'kici-no-such-binary',
        durationMs: Date.now() - startedAt,
      });
    }

    expect(err?.exitCode).toBeNull();
    expect(err?.timedOut).toBe(false);
    // `validateNftablesAvailability` matches ENOENT in the message.
    expect(err?.message).toContain('could not start');
    expect(err?.message).toContain('ENOENT');
  });

  it('bounds stderr to its tail', async () => {
    const err = await failingCommand(
      `head -c 10000 /dev/zero | tr '\\0' 'x' >&2; echo " the real reason" >&2; exit 1`,
    );

    expect(err.stderrTail.length).toBe(COMMAND_STDERR_TAIL_CHARS + 1);
    expect(err.stderrTail.startsWith('…')).toBe(true);
    expect(err.stderrTail.endsWith('the real reason')).toBe(true);
    expect(err.message.length).toBeLessThan(COMMAND_STDERR_TAIL_CHARS + 400);
  });

  it('keeps the whole message of an error that is not an exec error', () => {
    const err = toCommandError(new Error('first line\nsecond line'), {
      command: 'nft list tables',
      durationMs: 4,
    });

    expect(err.message).toBe(
      'Command `nft list tables` failed after 4 ms: first line\nsecond line',
    );
    expect(err.cause).toBeInstanceOf(Error);
  });
});

describe('stderrTail', () => {
  it('trims and accepts a Buffer', () => {
    expect(stderrTail(Buffer.from('  boom \n'))).toBe('boom');
    expect(stderrTail(undefined)).toBe('');
  });
});

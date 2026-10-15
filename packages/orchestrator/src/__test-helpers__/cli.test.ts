import { afterEach, describe, expect, it, vi } from 'vitest';
import { runCli } from './cli.js';

describe('runCli', () => {
  afterEach(() => vi.restoreAllMocks());

  it('captures console.log and console.error, each call one line', async () => {
    const r = await runCli(
      (p) => {
        p.command('hi').action(() => {
          console.log('a', 'b');
          console.log('c');
          console.error('e');
        });
      },
      ['hi'],
    );
    expect(r).toEqual({ stdout: 'a b\nc', stderr: 'e', exitCode: null });
  });

  it('records the process.exit code and stops the action there', async () => {
    let after = false;
    const r = await runCli(
      (p) => {
        p.command('fail').action(() => {
          process.exit(2);
          after = true;
        });
      },
      ['fail'],
    );
    expect(r.exitCode).toBe(2);
    expect(after).toBe(false);
  });

  it('records a bare process.exit() as 0', async () => {
    const r = await runCli((p) => p.command('ok').action(() => process.exit()), ['ok']);
    expect(r.exitCode).toBe(0);
  });

  // fails-when: a Commander parse error is re-thrown, or Commander's text is captured by default
  it('swallows a Commander parse error and leaves its text on the real stderr', async () => {
    const write = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const r = await runCli(
      (p) =>
        p
          .command('x')
          .requiredOption('--need <v>')
          .action(() => {}),
      ['x'],
    );
    expect(r).toEqual({ stdout: '', stderr: '', exitCode: null });
    expect(write.mock.calls.map((c) => String(c[0])).join('')).toMatch(/--need/);
  });

  // breaks-if-wrong: a crashing action must still fail the test that runs it
  it('re-throws an error that is neither an exit nor a Commander error', async () => {
    await expect(
      runCli(
        (p) =>
          p.command('boom').action(() => {
            throw new Error('real bug');
          }),
        ['boom'],
      ),
    ).rejects.toThrow('real bug');
  });

  it('restores console, process.exit and process.stderr.write after a throw', async () => {
    const { log, error } = console;
    const { exit } = process;
    const write = process.stderr.write;
    await runCli(
      (p) =>
        p.command('boom').action(() => {
          throw new Error('x');
        }),
      ['boom'],
      { captureStderrWrite: true },
    ).catch(() => undefined);
    expect(console.log).toBe(log);
    expect(console.error).toBe(error);
    expect(process.exit).toBe(exit);
    expect(process.stderr.write).toBe(write);
  });

  describe('captureStderrWrite', () => {
    // fails-when: a direct process.stderr.write is not captured with the option set
    it('captures direct writes, one trailing newline stripped', async () => {
      const r = await runCli(
        (p) =>
          p.command('w').action(() => {
            process.stderr.write('hint\n');
            process.stderr.write(Buffer.from('raw'));
          }),
        ['w'],
        { captureStderrWrite: true },
      );
      expect(r.stderr).toBe('hint\nraw');
    });

    it("captures Commander's own parse-error text", async () => {
      const r = await runCli(
        (p) =>
          p
            .command('x')
            .requiredOption('--need <v>')
            .action(() => {}),
        ['x'],
        { captureStderrWrite: true },
      );
      expect(r.stderr).toMatch(/required option '--need <v>' not specified/);
      expect(r.exitCode).toBeNull();
    });
  });

  describe('recordCommanderErrors', () => {
    // fails-when: a Commander error leaves exitCode null or its message out of stderr
    it("records a Commander error's message and exit code", async () => {
      vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
      const r = await runCli((p) => p.command('x').action(() => {}), ['x', '--nope'], {
        recordCommanderErrors: true,
      });
      expect(r.exitCode).toBe(1);
      expect(r.stderr).toMatch(/unknown option '--nope'/);
    });

    // breaks-if-wrong: a trapped process.exit must keep its own code under the option
    it('keeps the process.exit code', async () => {
      const r = await runCli((p) => p.command('f').action(() => process.exit(3)), ['f'], {
        recordCommanderErrors: true,
      });
      expect(r).toEqual({ stdout: '', stderr: '', exitCode: 3 });
    });
  });
});

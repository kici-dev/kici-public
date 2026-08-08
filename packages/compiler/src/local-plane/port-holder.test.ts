import { describe, it, expect } from 'vitest';
import net from 'node:net';
import { spawn } from 'node:child_process';
import {
  isPortFree,
  waitForPortFree,
  terminatePid,
  findPortHolderPid,
  parseSsOutput,
  parseLsofOutput,
  parseNetstatOutput,
  processCommandLine,
  type ExecFn,
} from './port-holder.js';

/** Captured verbatim from `ss -lptnH` on Linux. The process name is MainThread, not node. */
const SS_OUTPUT = [
  'LISTEN 0      511                      127.0.0.1:45998 0.0.0.0:* users:(("MainThread",pid=784723,fd=21))   ',
  'LISTEN 0      4096                     127.0.0.1:12345 0.0.0.0:*                                           ',
  'LISTEN 0      4096                          [::]:5355     [::]:*  users:(("systemd-resolve",pid=900,fd=12))',
].join('\n');

/** Captured verbatim from `lsof -nP -iTCP -sTCP:LISTEN -Fpn`. p lines precede their n lines. */
const LSOF_OUTPUT = [
  'p3418',
  'n127.0.0.1:36867',
  'p94006',
  'n*:10042',
  'p784723',
  'n127.0.0.1:45998',
].join('\n');

const NETSTAT_OUTPUT = [
  '  Proto  Local Address          Foreign Address        State           PID',
  '  TCP    127.0.0.1:45998        0.0.0.0:0              LISTENING       784723',
  '  TCP    127.0.0.1:9999         0.0.0.0:0              ESTABLISHED     4242',
].join('\n');

describe('output parsers', () => {
  it('parseSsOutput extracts the pid without matching the process name', () => {
    expect(parseSsOutput(SS_OUTPUT, 45998)).toBe(784723);
  });

  it('parseSsOutput returns null for a row with no users:() field', () => {
    expect(parseSsOutput(SS_OUTPUT, 12345)).toBeNull();
  });

  it('parseSsOutput reads the port after the LAST colon of an IPv6 address', () => {
    expect(parseSsOutput(SS_OUTPUT, 5355)).toBe(900);
  });

  it('parseSsOutput returns null when no row matches the port', () => {
    expect(parseSsOutput(SS_OUTPUT, 4319)).toBeNull();
  });

  it('parseLsofOutput tracks the current pid across the field stream', () => {
    expect(parseLsofOutput(LSOF_OUTPUT, 45998)).toBe(784723);
    expect(parseLsofOutput(LSOF_OUTPUT, 36867)).toBe(3418);
    expect(parseLsofOutput(LSOF_OUTPUT, 10042)).toBe(94006);
  });

  it('parseLsofOutput returns null for an unmatched port and for garbage', () => {
    expect(parseLsofOutput(LSOF_OUTPUT, 4319)).toBeNull();
    expect(parseLsofOutput('not lsof output at all', 4319)).toBeNull();
  });

  it('parseNetstatOutput takes the pid from LISTENING rows only', () => {
    expect(parseNetstatOutput(NETSTAT_OUTPUT, 45998)).toBe(784723);
    expect(parseNetstatOutput(NETSTAT_OUTPUT, 9999)).toBeNull();
  });
});

describe('findPortHolderPid', () => {
  const execOk =
    (stdout: string): ExecFn =>
    async () => ({ stdout, exitCode: 0 });

  it('uses ss on linux', async () => {
    const calls: string[] = [];
    const exec: ExecFn = async (cmd) => {
      calls.push(cmd);
      return { stdout: SS_OUTPUT, exitCode: 0 };
    };
    expect(await findPortHolderPid(45998, { exec, platform: 'linux' })).toBe(784723);
    expect(calls).toEqual(['ss']);
  });

  it('falls back to lsof on linux when ss parses to null (socket not owned by this user)', async () => {
    const calls: string[] = [];
    const exec: ExecFn = async (cmd) => {
      calls.push(cmd);
      return cmd === 'ss'
        ? { stdout: SS_OUTPUT, exitCode: 0 }
        : { stdout: 'p999\nn127.0.0.1:12345', exitCode: 0 };
    };
    // Port 12345 has no users:() field in the ss output, so ss yields null.
    expect(await findPortHolderPid(12345, { exec, platform: 'linux' })).toBe(999);
    expect(calls).toEqual(['ss', 'lsof']);
  });

  it('falls back to lsof on linux when ss exits non-zero', async () => {
    const exec: ExecFn = async (cmd) =>
      cmd === 'ss' ? { stdout: '', exitCode: 127 } : { stdout: LSOF_OUTPUT, exitCode: 0 };
    expect(await findPortHolderPid(45998, { exec, platform: 'linux' })).toBe(784723);
  });

  it('uses lsof directly on darwin', async () => {
    const calls: string[] = [];
    const exec: ExecFn = async (cmd) => {
      calls.push(cmd);
      return { stdout: LSOF_OUTPUT, exitCode: 0 };
    };
    expect(await findPortHolderPid(45998, { exec, platform: 'darwin' })).toBe(784723);
    expect(calls).toEqual(['lsof']);
  });

  it('uses netstat on win32', async () => {
    const exec = execOk(NETSTAT_OUTPUT);
    expect(await findPortHolderPid(45998, { exec, platform: 'win32' })).toBe(784723);
  });

  it('returns null when every tool fails, and never throws', async () => {
    const exec: ExecFn = async () => {
      throw new Error('spawn ENOENT');
    };
    await expect(findPortHolderPid(4319, { exec, platform: 'linux' })).resolves.toBeNull();
  });
});

describe('isPortFree / waitForPortFree', () => {
  it('reports a free port as free', async () => {
    expect(await isPortFree(45997)).toBe(true);
  });

  it('reports a held port as not free, then free once released', async () => {
    const server = net.createServer();
    await new Promise<void>((r) => server.listen({ port: 45996, host: '127.0.0.1' }, () => r()));
    expect(await isPortFree(45996)).toBe(false);
    await new Promise<void>((r) => server.close(() => r()));
    expect(await waitForPortFree(45996, 2_000)).toBe(true);
  });

  it('waitForPortFree returns false while the port stays held', async () => {
    const server = net.createServer();
    await new Promise<void>((r) => server.listen({ port: 45995, host: '127.0.0.1' }, () => r()));
    expect(await waitForPortFree(45995, 300)).toBe(false);
    await new Promise<void>((r) => server.close(() => r()));
  });
});

describe('terminatePid', () => {
  it('returns immediately for a pid that does not exist', async () => {
    await terminatePid(2147480000, 5_000);
  });

  it('stops a live child', async () => {
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      stdio: 'ignore',
    });
    await terminatePid(child.pid!, 5_000);
    expect(() => process.kill(child.pid!, 0)).toThrow();
  });

  it('gives up on a pid that survives SIGKILL instead of polling forever', async () => {
    // A pid that never disappears however hard it is signalled — a zombie
    // awaiting reaping, or a task stuck in uninterruptible I/O.
    const sent: Array<NodeJS.Signals | 0> = [];
    const started = Date.now();
    await terminatePid(424242, 20, {
      hardKillWaitMs: 60,
      kill: (_pid, sig) => void sent.push(sig),
    });
    expect(sent).toContain('SIGTERM');
    expect(sent).toContain('SIGKILL');
    expect(Date.now() - started).toBeLessThan(4_000);
  });

  it('escalates to SIGKILL when the child ignores SIGTERM', async () => {
    const child = spawn(
      process.execPath,
      ['-e', "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"],
      { stdio: 'ignore' },
    );
    // Give the handler time to install before signalling.
    await new Promise((r) => setTimeout(r, 300));
    await terminatePid(child.pid!, 500);
    expect(() => process.kill(child.pid!, 0)).toThrow();
  });
});

describe('processCommandLine', () => {
  it('joins the NUL-separated /proc entry on linux', async () => {
    const readProc = (p: string) => {
      expect(p).toBe('/proc/4242/cmdline');
      return ['/usr/bin/node', '/x/orchestrator/dist/standalone.js', ''].join('\0');
    };
    expect(await processCommandLine(4242, { platform: 'linux', readProc })).toBe(
      '/usr/bin/node /x/orchestrator/dist/standalone.js',
    );
  });

  it('returns null for a dead pid on linux (unreadable /proc entry)', async () => {
    const readProc = () => {
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    };
    expect(await processCommandLine(2147480000, { platform: 'linux', readProc })).toBeNull();
  });

  it('returns null for a kernel thread, whose cmdline is empty', async () => {
    expect(await processCommandLine(2, { platform: 'linux', readProc: () => '' })).toBeNull();
  });

  it('asks ps on darwin', async () => {
    const calls: Array<[string, string[]]> = [];
    const exec: ExecFn = async (cmd, args) => {
      calls.push([cmd, args]);
      return { stdout: 'node /x/orchestrator/dist/server.js\n', exitCode: 0 };
    };
    expect(await processCommandLine(77, { platform: 'darwin', exec })).toBe(
      'node /x/orchestrator/dist/server.js',
    );
    expect(calls).toEqual([['ps', ['-o', 'args=', '-p', '77']]]);
  });

  it('returns null when ps exits non-zero or prints nothing', async () => {
    const missing: ExecFn = async () => ({ stdout: '', exitCode: 1 });
    expect(await processCommandLine(77, { platform: 'darwin', exec: missing })).toBeNull();
    const empty: ExecFn = async () => ({ stdout: '   \n', exitCode: 0 });
    expect(await processCommandLine(77, { platform: 'darwin', exec: empty })).toBeNull();
  });

  it('returns null on win32 rather than guessing', async () => {
    expect(await processCommandLine(77, { platform: 'win32' })).toBeNull();
  });

  it('reads this very process on the real host', async () => {
    const line = await processCommandLine(process.pid);
    // Linux and macOS both answer for a live process we own; win32 returns null.
    if (process.platform === 'win32') expect(line).toBeNull();
    else expect(line).toContain('node');
  });
});

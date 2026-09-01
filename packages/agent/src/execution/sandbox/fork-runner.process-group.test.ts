import { describe, it, expect } from 'vitest';
import { spawn } from 'node:child_process';
import { killProcessGroup } from './fork-runner.js';

describe('killProcessGroup', () => {
  it('kills a detached child and its own child (the whole group)', async () => {
    // Parent spawns a child that itself spawns a long sleeper, all in one group.
    const parent = spawn(
      process.execPath,
      [
        '-e',
        'require("child_process").spawn("sleep",["30"],{stdio:"ignore"}); setInterval(()=>{},1e9);',
      ],
      { detached: true, stdio: 'ignore' },
    );
    await new Promise((r) => setTimeout(r, 200));
    const pid = parent.pid!;
    // killProcessGroup returns 0 or 1 by contract (signalled vs ESRCH).
    const signalled = killProcessGroup(pid, 'SIGKILL');
    expect(signalled).toBe(1);
    // Wait for the parent to be reaped (event-driven, not a fixed sleep) so the
    // group is provably gone before asserting ESRCH → 0. Racing Node's zombie
    // reaping with a fixed sleep is flaky under load.
    await new Promise<void>((resolve) => parent.on('exit', () => resolve()));
    // Give the kernel a beat to tear the (now leaderless) group down.
    await new Promise((r) => setTimeout(r, 100));
    expect(killProcessGroup(pid, 'SIGKILL')).toBe(0);
  });

  it('returns 0 for a pid that does not exist', () => {
    expect(killProcessGroup(2_147_483_646, 'SIGKILL')).toBe(0);
  });
});

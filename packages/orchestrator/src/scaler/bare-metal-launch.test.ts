import { describe, it, expect, afterEach } from 'vitest';
import { once } from 'node:events';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isBatchFile } from '../helpers/windows-batch.js';
import {
  TreeKillOutcome,
  agentLaunchRefusal,
  agentSpawnOptions,
  buildAgentLaunch,
  startAgentProcess,
  treeKillOutcome,
  windowsTreeKill,
  type AgentLaunchInput,
} from './bare-metal-launch.js';
import { DeterministicSpawnError, isDeterministicSpawnError } from './spawn-errors.js';

const WIN_ENV = { COMSPEC: 'C:\\Windows\\system32\\cmd.exe', SystemRoot: 'C:\\Windows' };

function onWindows(binaryPath: string): AgentLaunchInput {
  return {
    binaryPath,
    agentId: 'agent-1',
    enforceCgroups: false,
    platform: 'win32',
    hostEnv: WIN_ENV,
  };
}

function onLinux(over: Partial<AgentLaunchInput> = {}): AgentLaunchInput {
  return {
    binaryPath: '/opt/kici/kici-agent',
    agentId: 'agent-9',
    enforceCgroups: false,
    platform: 'linux',
    hostEnv: {},
    ...over,
  };
}

describe('buildAgentLaunch on Windows', () => {
  it('runs a .cmd launcher through cmd.exe', () => {
    // fails-when: the .cmd is the spawn command — Node.js throws EINVAL for it (CVE-2024-27980)
    expect(buildAgentLaunch(onWindows('C:\\kici\\service\\kici-agent.cmd'))).toEqual({
      command: 'C:\\Windows\\system32\\cmd.exe',
      args: ['/d', '/e:on', '/v:off', '/c', 'call', 'C:\\kici\\service\\kici-agent.cmd', '<NUL'],
    });
  });

  it.each([
    'C:\\kici\\agent\\kici-agent.cmd',
    'C:\\kici\\agent\\KICI-AGENT.CMD',
    'C:\\kici\\run.bat',
    'C:\\Program Files (x86)\\KiCI\\kici-agent.cmd',
    'C:\\Program Files\\A & B, C=D\\kici-agent.cmd',
  ])('never hands Node.js a batch file as the command: %s', (binaryPath) => {
    const launch = buildAgentLaunch(onWindows(binaryPath));
    expect(isBatchFile(launch.command)).toBe(false);
    expect(launch.args.filter((a) => a === binaryPath)).toHaveLength(1);
    // libuv quotes an argument only when it holds a space, a tab or `"`. The
    // cmd.exe safety rule is written against exactly that, so the path must be
    // the only argument libuv quotes.
    const quoted = launch.args.filter((a) => /[ \t"]/.test(a));
    expect(quoted).toEqual(/[ \t]/.test(binaryPath) ? [binaryPath] : []);
  });

  it.each(['C:\\node\\node.exe', 'C:\\kici\\kici-agent'])(
    'launches a non-batch binary directly: %s',
    (binaryPath) => {
      // breaks-if-wrong: a real executable gets wrapped in cmd.exe too
      expect(buildAgentLaunch(onWindows(binaryPath))).toEqual({ command: binaryPath, args: [] });
    },
  );

  it('refuses a batch path cmd.exe would read as syntax', () => {
    expect(() => buildAgentLaunch(onWindows('C:\\a&b\\kici-agent.cmd'))).toThrow(
      DeterministicSpawnError,
    );
  });

  it('never wraps in systemd-run, even with enforceCgroups and limits', () => {
    expect(
      buildAgentLaunch({
        ...onWindows('C:\\node\\node.exe'),
        enforceCgroups: true,
        effectiveLimits: { cpus: 2, memBytes: 1024 },
      }),
    ).toEqual({ command: 'C:\\node\\node.exe', args: [] });
  });
});

describe('buildAgentLaunch on Linux', () => {
  it('runs the binary directly', () => {
    expect(buildAgentLaunch(onLinux())).toEqual({ command: '/opt/kici/kici-agent', args: [] });
  });

  it('never wraps a .cmd path in cmd.exe', () => {
    expect(buildAgentLaunch(onLinux({ binaryPath: '/opt/x/kici-agent.cmd' }))).toEqual({
      command: '/opt/x/kici-agent.cmd',
      args: [],
    });
  });

  it('wraps in a systemd scope with enforceCgroups and positive limits', () => {
    expect(
      buildAgentLaunch(
        onLinux({ enforceCgroups: true, effectiveLimits: { cpus: 1.5, memBytes: 2048 } }),
      ),
    ).toEqual({
      command: 'systemd-run',
      args: [
        '--user',
        '--scope',
        '--quiet',
        '--slice=kici-scaler',
        '--unit=kici-agent-agent-9',
        '--property=CPUQuota=150%',
        '--property=MemoryMax=2048',
        '/opt/kici/kici-agent',
      ],
    });
  });

  it('stays direct with enforceCgroups but no positive limit', () => {
    expect(
      buildAgentLaunch(
        onLinux({ enforceCgroups: true, effectiveLimits: { cpus: 0, memBytes: 0 } }),
      ),
    ).toEqual({ command: '/opt/kici/kici-agent', args: [] });
  });
});

describe('agentLaunchRefusal', () => {
  it('names the character on a Windows host', () => {
    expect(agentLaunchRefusal('C:\\a&b\\kici-agent.cmd', 'win32')).toBe(
      'cannot run "C:\\a&b\\kici-agent.cmd" as a bare-metal agent: it contains "&", which ' +
        'cmd.exe reads as syntax when it runs the batch file. Move the agent to a path without it.',
    );
  });
  it('accepts the same path on a Linux host', () => {
    expect(agentLaunchRefusal('C:\\a&b\\kici-agent.cmd', 'linux')).toBeNull();
  });
  it('accepts a non-batch Windows path', () => {
    expect(agentLaunchRefusal('C:\\a&b\\kici-agent.exe', 'win32')).toBeNull();
  });
});

describe('agentSpawnOptions', () => {
  it('detaches on Linux and macOS, hides the console window and pipes output', () => {
    for (const platform of ['linux', 'darwin'] as const) {
      expect(agentSpawnOptions({ A: '1' }, platform)).toEqual({
        detached: true,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { A: '1' },
      });
    }
  });

  it('does not detach on Windows, so the agent writes to the pipes', () => {
    // fails-when: a Windows agent is detached — cmd.exe has no console and the
    // agent's node writes to a hidden console of its own; the scaler reads nothing.
    // breaks-if-wrong: the Linux process group destroy() signals is lost (case above).
    expect(agentSpawnOptions({ A: '1' }, 'win32')).toMatchObject({
      detached: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  });
});

describe('windowsTreeKill / treeKillOutcome', () => {
  it('ends the tree by pid with the System32 taskkill', () => {
    expect(windowsTreeKill(4242, { SystemRoot: 'D:\\Win' })).toEqual({
      command: 'D:\\Win\\System32\\taskkill.exe',
      args: ['/T', '/F', '/PID', '4242'],
    });
  });
  it('defaults SystemRoot to C:\\Windows', () => {
    expect(windowsTreeKill(1, {}).command).toBe('C:\\Windows\\System32\\taskkill.exe');
  });
  it.each([
    [0, TreeKillOutcome.Ended],
    [128, TreeKillOutcome.AlreadyGone],
    [1, TreeKillOutcome.Failed],
    [null, TreeKillOutcome.Failed],
  ])('exit %s is %s', (code, outcome) => {
    expect(treeKillOutcome(code)).toBe(outcome);
  });
});

describe.skipIf(process.platform === 'win32')('startAgentProcess (real spawns)', () => {
  let dir: string | undefined;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  it('starts a direct launch with the env it is given', async () => {
    // breaks-if-wrong: the wrapper refuses a launch the host accepts
    dir = mkdtempSync(join(tmpdir(), 'kici-launch-'));
    const script = join(dir, 'agent.sh');
    const out = join(dir, 'out.txt');
    writeFileSync(script, `#!/bin/sh\nprintf '%s' "$KICI_PROBE" > "$PROBE_OUT"\n`);
    chmodSync(script, 0o755);
    const child = startAgentProcess(
      buildAgentLaunch(onLinux({ binaryPath: script })),
      {
        KICI_PROBE: 'launched',
        PROBE_OUT: out,
        PATH: process.env.PATH ?? '/usr/bin:/bin',
      },
      'linux',
    );
    const [code] = await once(child, 'exit');
    expect(code).toBe(0);
    expect(readFileSync(out, 'utf-8')).toBe('launched');
  });

  // Linux only: macOS caps the total argument and environment size, not one string.
  it.runIf(process.platform === 'linux')(
    'turns a launch the kernel refuses into a DeterministicSpawnError',
    () => {
      // fails-when: the synchronous throw escapes as a plain Error, so the manager
      // frees the capacity and re-drives straight into the same refusal.
      // An env string longer than MAX_ARG_STRLEN (32 pages) makes execve fail E2BIG.
      let caught: unknown;
      try {
        startAgentProcess(
          buildAgentLaunch(onLinux({ binaryPath: '/bin/true' })),
          { OVERSIZED_VALUE: 'x'.repeat(140_000) },
          'linux',
        );
      } catch (err) {
        caught = err;
      }
      expect(isDeterministicSpawnError(caught)).toBe(true);
      expect((caught as Error).message).toContain('spawn E2BIG');
      expect(((caught as Error).cause as NodeJS.ErrnoException).code).toBe('E2BIG');
    },
  );

  it('leaves a missing binary to the asynchronous error event', async () => {
    // breaks-if-wrong: an ENOENT (fixable on disk at any time) is classified as a refusal
    dir = mkdtempSync(join(tmpdir(), 'kici-launch-'));
    const child = startAgentProcess(
      buildAgentLaunch(onLinux({ binaryPath: join(dir, 'missing') })),
      {},
      'linux',
    );
    const [err] = await once(child, 'error');
    expect((err as NodeJS.ErrnoException).code).toBe('ENOENT');
  });
});

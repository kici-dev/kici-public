/**
 * Starting and ending a bare-metal agent process.
 *
 * Each decision about the launch is a pure function, so a test computes the
 * exact command a host runs without starting anything:
 *   - Windows runs a `.cmd` / `.bat` launcher through cmd.exe. Node.js refuses
 *     to start a batch file without a shell, and every launcher a KiCI package
 *     ships on Windows is one.
 *   - Linux with `enforceCgroups` wraps the agent in a transient systemd scope.
 *   - Everything else runs the binary directly.
 */
import { execFile, spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import path from 'node:path';
import { toErrorMessage } from '@kici-dev/shared';
import { batchFileCommand, cmdSafetyRefusal, isBatchFile } from '../helpers/windows-batch.js';
import { DeterministicSpawnError } from './spawn-errors.js';
import type { EffectiveLimits } from './types.js';

export interface AgentLaunchInput {
  binaryPath: string;
  agentId: string;
  effectiveLimits?: EffectiveLimits;
  enforceCgroups: boolean;
  platform: NodeJS.Platform;
  /** The orchestrator's own environment; read for COMSPEC and SystemRoot on Windows. */
  hostEnv: NodeJS.ProcessEnv;
}

/** A command and its arguments, as `spawn` / `execFile` take them. */
export interface AgentLaunch {
  command: string;
  args: string[];
}

const LAUNCH_USE = 'as a bare-metal agent';
const LAUNCH_REMEDY = 'Move the agent to a path without it.';

/**
 * Why a Windows host cannot run `binaryPath` through cmd.exe, or null. Only a
 * batch file on a Windows host goes through cmd.exe, so any other path or host
 * is accepted.
 */
export function agentLaunchRefusal(binaryPath: string, platform: NodeJS.Platform): string | null {
  if (platform !== 'win32' || !isBatchFile(binaryPath)) return null;
  return cmdSafetyRefusal(binaryPath, LAUNCH_USE, LAUNCH_REMEDY);
}

function positive(n: number | undefined): number {
  return typeof n === 'number' && n > 0 ? n : 0;
}

/**
 * The command that starts the agent on this host.
 *
 * `CPUQuota` is a percent (1.0 cpus = 100%) and `MemoryMax` a raw byte count.
 * The scope name embeds the agent id, so `systemctl --user status
 * kici-agent-<agentId>.scope` finds it.
 *
 * @throws DeterministicSpawnError for a Windows batch path cmd.exe would read
 *   as syntax. Config validation refuses such a path first.
 */
export function buildAgentLaunch(input: AgentLaunchInput): AgentLaunch {
  const { binaryPath, platform } = input;
  if (platform === 'win32' && isBatchFile(binaryPath)) {
    const refusal = agentLaunchRefusal(binaryPath, platform);
    if (refusal) throw new DeterministicSpawnError(refusal);
    const [command, ...args] = batchFileCommand([binaryPath], input.hostEnv);
    return { command: command!, args };
  }

  const cpus = positive(input.effectiveLimits?.cpus);
  const memBytes = positive(input.effectiveLimits?.memBytes);
  if (!input.enforceCgroups || platform !== 'linux' || (cpus === 0 && memBytes === 0)) {
    return { command: binaryPath, args: [] };
  }

  const args = [
    '--user',
    '--scope',
    '--quiet',
    '--slice=kici-scaler',
    `--unit=kici-agent-${input.agentId}`,
  ];
  if (cpus > 0) args.push(`--property=CPUQuota=${Math.max(1, Math.round(cpus * 100))}%`);
  if (memBytes > 0) args.push(`--property=MemoryMax=${memBytes}`);
  args.push(binaryPath);
  return { command: 'systemd-run', args };
}

/**
 * Spawn options for an agent process.
 *
 * On Linux and macOS the agent is detached: it leads its own process group,
 * which `destroy()` signals.
 *
 * On Windows it is not. A detached process starts with no console, and the
 * cmd.exe that runs a batch launcher then starts the agent's `node` in a new,
 * hidden console of its own, so the agent's output never reaches the pipes the
 * scaler reads. Not detached, cmd.exe gets a hidden console (`windowsHide`
 * with no inherited stdio) that `node` shares, along with the pipes. Node.js
 * puts a child that is not detached into a job object that ends it when the
 * orchestrator exits; processes that child starts are not in that job, so the
 * agent itself outlives an orchestrator restart, as it does on Linux and macOS.
 */
export function agentSpawnOptions(
  env: Record<string, string>,
  platform: NodeJS.Platform,
): SpawnOptions {
  return {
    detached: platform !== 'win32',
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env,
  };
}

/**
 * Start the agent process.
 *
 * Node.js reports a missing or unreadable binary later, through the child's
 * `'error'` event. Any other launch failure throws here, synchronously: the
 * host refused this exact invocation (a Windows batch file without cmd.exe, an
 * environment string longer than the kernel accepts), and it will refuse the
 * next one the same way.
 *
 * @throws DeterministicSpawnError for that synchronous refusal.
 */
export function startAgentProcess(
  launch: AgentLaunch,
  env: Record<string, string>,
  platform: NodeJS.Platform,
): ChildProcess {
  try {
    return spawn(launch.command, launch.args, agentSpawnOptions(env, platform));
  } catch (err) {
    throw new DeterministicSpawnError(
      `the host refused to start the agent process (${launch.command}): ${toErrorMessage(err)}`,
      { cause: err },
    );
  }
}

/** The taskkill command that ends a Windows process and every process it started. */
export function windowsTreeKill(pid: number, hostEnv: NodeJS.ProcessEnv): AgentLaunch {
  const systemRoot = hostEnv.SystemRoot ?? hostEnv.SYSTEMROOT ?? 'C:\\Windows';
  return {
    command: path.win32.join(systemRoot, 'System32', 'taskkill.exe'),
    args: ['/T', '/F', '/PID', String(pid)],
  };
}

/** What a taskkill exit code means for the tree it was asked to end. */
export enum TreeKillOutcome {
  Ended = 'ended',
  /** No process had the pid: the tree exited on its own first. */
  AlreadyGone = 'already-gone',
  Failed = 'failed',
}

/** taskkill exits 0 when it ended the tree and 128 when no process had the pid. */
export function treeKillOutcome(exitCode: number | null): TreeKillOutcome {
  if (exitCode === 0) return TreeKillOutcome.Ended;
  if (exitCode === 128) return TreeKillOutcome.AlreadyGone;
  return TreeKillOutcome.Failed;
}

/**
 * End a Windows process tree with `taskkill /T /F`. Resolves when the tree was
 * ended or was already gone; rejects with taskkill's exit code and stderr
 * otherwise.
 */
export function killWindowsTree(
  pid: number,
  hostEnv: NodeJS.ProcessEnv,
  timeoutMs: number,
): Promise<void> {
  const { command, args } = windowsTreeKill(pid, hostEnv);
  return new Promise((resolve, reject) => {
    execFile(command, args, { windowsHide: true, timeout: timeoutMs }, (err, _stdout, stderr) => {
      const rawCode = (err as { code?: unknown } | null)?.code;
      const exitCode = err === null ? 0 : typeof rawCode === 'number' ? rawCode : null;
      if (treeKillOutcome(exitCode) !== TreeKillOutcome.Failed) {
        resolve();
        return;
      }
      const detail = String(stderr ?? '').trim() || toErrorMessage(err);
      reject(
        new Error(`taskkill /T /F /PID ${pid} failed (exit ${exitCode ?? 'none'}): ${detail}`),
      );
    });
  });
}

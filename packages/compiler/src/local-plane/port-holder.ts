/**
 * OS-level ownership of the local dev plane's port: whether it is occupied, and
 * by which process — what the plane's on-disk stamp cannot answer. Every failure
 * degrades to `null` rather than throwing: a discovery failure must never break
 * the command that asked.
 */
import net from 'node:net';
import fs from 'node:fs';
import { execFile } from 'node:child_process';

/** Command runner, injectable so each platform branch is unit-testable anywhere. */
export type ExecFn = (cmd: string, args: string[]) => Promise<{ stdout: string; exitCode: number }>;

const defaultExec: ExecFn = (cmd, args) =>
  new Promise((resolve) => {
    execFile(cmd, args, { timeout: 5_000, maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => {
      const raw = (err as { code?: unknown } | null)?.code;
      const code = typeof raw === 'number' ? raw : err ? 1 : 0;
      resolve({ stdout: stdout ?? '', exitCode: code });
    });
  });

/**
 * Command line of process `pid` (Linux reads `/proc`, other platforms `ps`).
 *
 * **A null means "cannot tell", never "not that process."** Callers must treat
 * it as absence of evidence — the only safe reading when the answer decides
 * whether to signal a pid.
 */
export async function processCommandLine(
  pid: number,
  opts: {
    exec?: ExecFn;
    platform?: NodeJS.Platform;
    readProc?: (path: string) => string;
  } = {},
): Promise<string | null> {
  const platform = opts.platform ?? process.platform;
  try {
    if (platform === 'linux') {
      const readProc = opts.readProc ?? ((p: string) => fs.readFileSync(p, 'utf-8'));
      const raw = readProc(`/proc/${pid}/cmdline`);
      const joined = raw.split('\0').filter(Boolean).join(' ').trim();
      return joined === '' ? null : joined;
    }
    if (platform === 'win32') return null;
    const exec = opts.exec ?? defaultExec;
    const r = await exec('ps', ['-o', 'args=', '-p', String(pid)]);
    if (r.exitCode !== 0) return null;
    const line = r.stdout.trim();
    return line === '' ? null : line;
  } catch {
    return null;
  }
}

/**
 * Probes `127.0.0.1`, the address the CLI talks to; a `0.0.0.0` listener still
 * makes this bind fail with EADDRINUSE, so there is no false "free".
 */
export function isPortFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = net.createServer();
    probe.once('error', () => resolve(false));
    probe.listen({ port, host: '127.0.0.1', exclusive: true }, () => {
      probe.close(() => resolve(true));
    });
  });
}

/** The segment after the LAST colon, because an IPv6 address is written `[::]:5355`. */
function addressPort(addr: string): number | null {
  const i = addr.lastIndexOf(':');
  if (i < 0) return null;
  const n = Number(addr.slice(i + 1));
  return Number.isInteger(n) ? n : null;
}

/**
 * Parse `ss -lptnH` rows. Only `pid=N` is matched, not the process name (a Node
 * listener reports as `MainThread`). A socket this user does not own has no
 * `users:(…)` field and yields null, which sends the caller to the lsof fallback.
 */
export function parseSsOutput(stdout: string, port: number): number | null {
  for (const line of stdout.split('\n')) {
    const cols = line.trim().split(/\s+/);
    if (cols.length < 4) continue;
    if (addressPort(cols[3]) !== port) continue;
    const m = /pid=(\d+)/.exec(line);
    return m ? Number(m[1]) : null;
  }
  return null;
}

/**
 * Parse `lsof -Fpn`: a stateful stream where each `p<pid>` line precedes its
 * `n<address>` lines.
 */
export function parseLsofOutput(stdout: string, port: number): number | null {
  let current: number | null = null;
  for (const line of stdout.split('\n')) {
    if (line.startsWith('p')) {
      const n = Number(line.slice(1));
      current = Number.isInteger(n) ? n : null;
    } else if (line.startsWith('n') && current !== null) {
      if (addressPort(line.slice(1)) === port) return current;
    }
  }
  return null;
}

/** Parse `netstat -ano -p tcp`: LISTENING rows only, pid in the last column. */
export function parseNetstatOutput(stdout: string, port: number): number | null {
  for (const line of stdout.split('\n')) {
    const cols = line.trim().split(/\s+/);
    if (cols.length < 5) continue;
    if (!/^LISTENING$/i.test(cols[3])) continue;
    if (addressPort(cols[1]) !== port) continue;
    const pid = Number(cols[cols.length - 1]);
    return Number.isInteger(pid) ? pid : null;
  }
  return null;
}

/**
 * Pid listening on `port`. Each platform runs the UNFILTERED listing and matches
 * the port here, because a tool's filter syntax is the fragile part. On Linux a
 * null parse also falls through to lsof: ss omits the owning process for sockets
 * this user does not own.
 */
export async function findPortHolderPid(
  port: number,
  opts: { exec?: ExecFn; platform?: NodeJS.Platform } = {},
): Promise<number | null> {
  const exec = opts.exec ?? defaultExec;
  const platform = opts.platform ?? process.platform;
  const viaLsof = async (): Promise<number | null> => {
    const r = await exec('lsof', ['-nP', '-iTCP', '-sTCP:LISTEN', '-Fpn']);
    return r.exitCode === 0 ? parseLsofOutput(r.stdout, port) : null;
  };
  try {
    if (platform === 'win32') {
      const r = await exec('netstat', ['-ano', '-p', 'tcp']);
      return r.exitCode === 0 ? parseNetstatOutput(r.stdout, port) : null;
    }
    if (platform === 'linux') {
      const r = await exec('ss', ['-lptnH']);
      const pid = r.exitCode === 0 ? parseSsOutput(r.stdout, port) : null;
      return pid ?? (await viaLsof());
    }
    return await viaLsof();
  } catch {
    return null;
  }
}

/** Signal sender, injectable so the escalation windows are unit-testable. */
export type KillFn = (pid: number, signal: NodeJS.Signals | 0) => void;

const defaultKill: KillFn = (pid, signal) => process.kill(pid, signal);

/** How long to keep watching for the process to disappear after SIGKILL. */
const HARD_KILL_WAIT_MS = 5_000;

/**
 * SIGTERM `pid`, escalate to SIGKILL past the grace window, and poll until it
 * exits. On Windows every signal terminates unconditionally, so this is a single
 * hard kill there.
 *
 * Resolving does NOT prove the process died: a pid surviving SIGKILL (a zombie,
 * or a task wedged in uninterruptible I/O) is abandoned after `hardKillWaitMs`,
 * because a teardown that hangs forever is worse than one reporting the port
 * still held. Callers decide from `waitForPortFree`, never from this resolving.
 */
export async function terminatePid(
  pid: number,
  graceMs = 10_000,
  opts: { hardKillWaitMs?: number; kill?: KillFn } = {},
): Promise<void> {
  const kill = opts.kill ?? defaultKill;
  const hardKillWaitMs = opts.hardKillWaitMs ?? HARD_KILL_WAIT_MS;
  try {
    kill(pid, 'SIGTERM');
  } catch {
    return; // ESRCH (already gone) or EPERM (not ours to signal) — nothing to wait for.
  }
  let deadline = Date.now() + graceMs;
  let killed = false;
  for (;;) {
    try {
      kill(pid, 0);
    } catch {
      return; // ESRCH — the process is gone (socket released).
    }
    if (Date.now() > deadline) {
      if (killed) return; // Survived SIGKILL — leave the verdict to the port probe.
      try {
        kill(pid, 'SIGKILL');
      } catch {
        return;
      }
      killed = true;
      deadline = Date.now() + hardKillWaitMs;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
}

/**
 * Poll until the port is bindable. This, not `terminatePid`, decides a teardown:
 * `terminatePid` abandons a pid that survives SIGKILL, and an exited process can
 * leave its listening socket lingering a moment on some platforms.
 */
export async function waitForPortFree(port: number, timeoutMs = 5_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await isPortFree(port)) return true;
    if (Date.now() >= deadline) return false;
    await new Promise((r) => setTimeout(r, 100));
  }
}

/**
 * OS-level ownership of the local dev plane's port.
 *
 * Answers two questions the plane's on-disk stamp cannot: is the port occupied
 * at all, and which process occupies it. Every external command is reached
 * through an injectable `ExecFn` so each platform branch has a real unit test on
 * any host, and every failure degrades to `null` rather than throwing — a
 * discovery failure must never break the command that asked.
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
 * Command line of process `pid`, or null when it cannot be determined.
 *
 * Linux exposes it as a NUL-separated `/proc` file; every other platform is
 * asked through the same injectable `ExecFn` the port discovery above uses.
 *
 * **A null means "cannot tell", never "not that process."** Callers must treat
 * it as an absence of evidence — the only safe reading when the answer decides
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
      // Arguments are NUL-separated, with a trailing NUL on a normal process.
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
 * Whether the port can be bound on loopback. Probes `127.0.0.1` because that is
 * the address the CLI talks to; a listener bound to `0.0.0.0` still makes this
 * bind fail with EADDRINUSE, so there is no false "free".
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

/**
 * Port of a socket address column. The port is the segment after the LAST
 * colon, because an IPv6 address is written `[::]:5355`.
 */
function addressPort(addr: string): number | null {
  const i = addr.lastIndexOf(':');
  if (i < 0) return null;
  const n = Number(addr.slice(i + 1));
  return Number.isInteger(n) ? n : null;
}

/**
 * Parse `ss -lptnH` rows. The process name is deliberately NOT matched — a Node
 * listener reports as `MainThread` — so only `pid=N` is extracted. A row for a
 * socket this user does not own carries no `users:(…)` field at all and yields
 * null, which is what sends the caller to the lsof fallback.
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
 * Parse `lsof -Fpn` field output, which is a stateful stream: each `p<pid>` line
 * precedes the `n<address>` lines belonging to that pid.
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
 * Pid of the process listening on `port`, or null when it cannot be determined.
 * Each platform runs the UNFILTERED listing and matches the port here rather
 * than passing a filter expression to the tool, whose syntax is the fragile
 * part. On Linux a null parse falls through to lsof as well as a non-zero exit,
 * because ss omits the owning-process field for sockets this user does not own.
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
 * Poll until process `pid` has exited, sending SIGTERM first and escalating to
 * SIGKILL past the grace window. `process.kill(pid, 0)` throws ESRCH once the
 * process is gone. On Windows every signal terminates unconditionally, so the
 * escalation collapses into a single hard kill there.
 *
 * Resolving does NOT prove the process died: a pid that survives SIGKILL (a
 * zombie awaiting reaping, or a task wedged in uninterruptible I/O) is given
 * `hardKillWaitMs` and then abandoned, because a teardown command that hangs
 * forever is worse than one that reports the port is still held. Callers decide
 * the outcome from the port itself — `waitForPortFree` — never from this
 * resolving.
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
 * Poll until the port is bindable. This, not `terminatePid` resolving, is what
 * decides a teardown: `terminatePid` abandons a pid that survives SIGKILL, and
 * even a process that did exit can leave its listening socket lingering a moment
 * longer on some platforms.
 */
export async function waitForPortFree(port: number, timeoutMs = 5_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await isPortFree(port)) return true;
    if (Date.now() >= deadline) return false;
    await new Promise((r) => setTimeout(r, 100));
  }
}

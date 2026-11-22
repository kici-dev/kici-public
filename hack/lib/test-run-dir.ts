/**
 * The per-run temp folder every vitest run in this repository writes into, and
 * its removal.
 *
 * `isolateTestRun()` makes `<base>/kici-test/run-XXXXXX` (base: `KICI_TMPDIR`,
 * else the system temp directory) and points `TMPDIR`, `KICI_TMPDIR` and the
 * `KICI_TEST_RUN_DIR` marker at it, so every temp file the run and its
 * subprocesses create lands in one place. On exit the folder goes when the run
 * passed, and stays for `KEEP_MS` with a stamp when it failed. A process that
 * already carries the marker inherits the folder and registers nothing, so a
 * nested run never deletes its parent's folder. Only a vitest process takes a
 * folder: other tools load vitest configs too (knip's vitest plugin does), and
 * would otherwise leave a stamped empty folder each time they exit non-zero.
 *
 * A run killed before its exit listener fires leaves the folder behind. The
 * owner file (`<pid>@<startTicks>`) lets a host sweep tell a live run from a
 * dead one, and the keep stamp tells it when a failed run's folder expires;
 * the names, file formats and removal live here so both ends share them.
 *
 * Side-effect free, so a sweep can import it.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { $ } from 'zx';

/** The parent folder's name; the same parent `@kici-dev/test-support/tmp` uses. */
export const TEST_RUN_PARENT = 'kici-test';

export const TEST_RUN_PREFIX = 'run-';

/** `mkdtemp` appends six characters of `[A-Za-z0-9]` to the prefix. */
export const TEST_RUN_NAME_RE = /^run-[A-Za-z0-9]{6}$/;

/**
 * Set to `true` by vitest's CLI (`startVitest` and `vitest list`) before it
 * loads any config, and inherited by its workers.
 */
export const VITEST_ENV = 'VITEST';

/** The marker: the active run folder's path. */
export const TEST_RUN_ENV = 'KICI_TEST_RUN_DIR';

/** `TMPDIR` before the override; the empty string when it was unset. */
export const TEST_RUN_ORIG_TMPDIR_ENV = 'KICI_TEST_RUN_ORIG_TMPDIR';

/** `KICI_TMPDIR` before the override; the empty string when it was unset. */
export const TEST_RUN_ORIG_KICI_TMPDIR_ENV = 'KICI_TEST_RUN_ORIG_KICI_TMPDIR';

/** The owning process, as `<pid>@<startTicks>\n`. */
export const OWNER_FILE = '.kici-run-owner';

/** When a failed run's folder may be removed, as an ISO timestamp. */
export const KEEP_FILE = '.kici-run-keep-until';

const DAY_MS = 24 * 60 * 60 * 1000;

export const KEEP_MS = 3 * DAY_MS;

export interface RunOwner {
  pid: number;
  startTicks: number;
}

/**
 * The start time of `pid` in clock ticks since boot: field 22 of
 * `/proc/<pid>/stat`. A recycled pid has a different start time, so the pair
 * identifies one process. Null when the file cannot be read or parsed.
 */
export function procStartTicks(pid: number): number | null {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    // Field 2 is the command name in parentheses and may itself contain spaces
    // or `)`, so the fields are counted from after the last `)`, where field 3
    // begins.
    const fields = stat
      .slice(stat.lastIndexOf(')') + 1)
      .trim()
      .split(/\s+/);
    const ticks = Number(fields[22 - 3]);
    return Number.isSafeInteger(ticks) && ticks >= 0 ? ticks : null;
  } catch {
    return null;
  }
}

function readFileOrNull(file: string): string | null {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

export function readOwner(dir: string): RunOwner | null {
  const content = readFileOrNull(path.join(dir, OWNER_FILE));
  const match = content?.trim().match(/^(\d+)@(\d+)$/);
  if (!match) return null;
  return { pid: Number(match[1]), startTicks: Number(match[2]) };
}

/** The keep stamp as epoch milliseconds, or null when absent or unparsable. */
export function readKeepUntil(dir: string): number | null {
  const content = readFileOrNull(path.join(dir, KEEP_FILE));
  if (content === null) return null;
  const ms = Date.parse(content.trim());
  return Number.isNaN(ms) ? null : ms;
}

/**
 * The folder every run folder is created in: under `KICI_TMPDIR`, else
 * `TMPDIR`, both read from `env`, else the system temp directory.
 */
export function testRunBase(env: NodeJS.ProcessEnv): string {
  return path.join(env.KICI_TMPDIR || env.TMPDIR || os.tmpdir(), TEST_RUN_PARENT);
}

export enum RemoveOutcome {
  Removed = 'removed',
  RemovedWithSudo = 'removed-with-sudo',
  Refused = 'refused',
  Failed = 'failed',
}

/**
 * A container build run by a test can leave root-owned files in the folder,
 * which only root can remove. `-n` never prompts: without passwordless sudo it
 * fails, and the caller reports the folder as not removed.
 */
function sudoRm(dir: string): boolean {
  const out = $.sync({
    nothrow: true,
    quiet: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  })`sudo -n rm -rf -- ${dir}`;
  return out.exitCode === 0;
}

function errorCode(err: unknown): string | undefined {
  return err instanceof Error && 'code' in err ? String(err.code) : undefined;
}

/**
 * Remove the run folder `dir`, falling back to `runSudo` when a permission
 * error stops the plain removal. Never throws.
 *
 * Refuses anything that is not a run folder directly inside one of `bases`:
 * the sudo fallback deletes as root, so a wrong path must never reach it.
 */
export function removeRunDir(
  dir: string,
  bases: readonly string[],
  runSudo: (dir: string) => boolean = sudoRm,
): RemoveOutcome {
  try {
    const resolved = path.resolve(dir);
    const parent = path.dirname(resolved);
    // fails-when: a broken check lets through `/elsewhere/run-aB3dE9` (a run-named
    // folder outside every base) or `<base>/other`, and removes it, as root once
    // the sudo fallback is reached.
    // breaks-if-wrong: a base passed unresolved (`<base>/.`) still matches its run folders.
    if (!bases.some((b) => path.resolve(b) === parent)) return RemoveOutcome.Refused;
    if (!TEST_RUN_NAME_RE.test(path.basename(resolved))) return RemoveOutcome.Refused;
    try {
      fs.rmSync(resolved, { recursive: true, force: true });
      return RemoveOutcome.Removed;
    } catch (err) {
      const code = errorCode(err);
      if (code !== 'EACCES' && code !== 'EPERM') return RemoveOutcome.Failed;
    }
    return runSudo(resolved) ? RemoveOutcome.RemovedWithSudo : RemoveOutcome.Failed;
  } catch {
    return RemoveOutcome.Failed;
  }
}

export interface IsolateOptions {
  /** Registers the exit listener; defaults to `process.once('exit', fn)`. */
  onExit?: (fn: (code: number) => void) => void;
  now?: () => number;
  /** Prints a kept or not-removed folder; defaults to stderr. */
  print?: (line: string) => void;
  /** The host name printed beside the folder; defaults to `os.hostname()`. */
  host?: string;
  /** The root fallback `removeRunDir` uses on a permission error; defaults to `sudo -n rm -rf`. */
  runSudo?: (dir: string) => boolean;
}

/**
 * Create this run's folder, point `TMPDIR`, `KICI_TMPDIR` and the marker at
 * it, and register its removal or stamp on exit. Returns the folder it
 * created, or undefined when `env` already carries the marker (the process
 * then inherits the folder, and its exit leaves it alone) or does not come
 * from vitest (`VITEST_ENV` unset: the process gets no folder and `env` is
 * left as it was).
 */
export function isolateTestRun(
  env: NodeJS.ProcessEnv = process.env,
  opts: IsolateOptions = {},
): string | undefined {
  // fails-when: knip (or any tool that loads a vitest config) imports this with
  // VITEST unset — without the check it makes, and on exit 1 stamps, a folder.
  // breaks-if-wrong: a real `vitest run` sets VITEST and must still get a folder.
  if (!env[VITEST_ENV]) return undefined;
  if (env[TEST_RUN_ENV]) return undefined;

  // The base is taken before the override: afterwards KICI_TMPDIR names the
  // run folder itself, and removal would refuse it.
  const base = testRunBase(env);
  fs.mkdirSync(base, { recursive: true });
  const dir = fs.mkdtempSync(path.join(base, TEST_RUN_PREFIX));

  const startTicks = procStartTicks(process.pid);
  // Without a readable start time (no /proc) an owner file could not tell this
  // process from a recycled pid, so none is written.
  if (startTicks !== null) {
    fs.writeFileSync(path.join(dir, OWNER_FILE), `${process.pid}@${startTicks}\n`);
  }

  env[TEST_RUN_ORIG_TMPDIR_ENV] = env.TMPDIR ?? '';
  env[TEST_RUN_ORIG_KICI_TMPDIR_ENV] = env.KICI_TMPDIR ?? '';
  env.TMPDIR = dir;
  env.KICI_TMPDIR = dir;
  env[TEST_RUN_ENV] = dir;

  const onExit = opts.onExit ?? ((fn) => process.once('exit', fn));
  const now = opts.now ?? Date.now;
  const print = opts.print ?? ((line: string) => process.stderr.write(`${line}\n`));
  const host = opts.host ?? os.hostname();

  onExit((code) => {
    try {
      if (code === 0) {
        if (removeRunDir(dir, [base], opts.runSudo) === RemoveOutcome.Failed) {
          print(`test temp could not be removed: ${host}:${dir}`);
        }
        return;
      }
      fs.writeFileSync(path.join(dir, KEEP_FILE), new Date(now() + KEEP_MS).toISOString());
      print(`test temp kept for ${KEEP_MS / DAY_MS} days: ${host}:${dir}`);
    } catch {
      // A throw from an `exit` listener would replace the run's exit code with
      // 1; a host sweep reaps whatever is left.
    }
  });
  return dir;
}

/** What `persistentTmpEnv` returns: every key always present. */
export interface PersistentTmpEnv {
  TMPDIR: string | undefined;
  KICI_TMPDIR: string | undefined;
  [TEST_RUN_ENV]: undefined;
  [TEST_RUN_ORIG_TMPDIR_ENV]: undefined;
  [TEST_RUN_ORIG_KICI_TMPDIR_ENV]: undefined;
}

/**
 * The env a process that outlives this run should get over the inherited one:
 * `TMPDIR` and `KICI_TMPDIR` from before the override, and no run-folder
 * markers. Every key is always present, and a variable that was unset comes
 * back as `undefined`, so `{ ...process.env, ...persistentTmpEnv() }` clears
 * it: the spawn and zx skip an `undefined` env value, so the long-lived process
 * never sees the run folder, and a vitest run it starts later makes a folder of
 * its own instead of inheriting this one. When no run is active, the current
 * temp values.
 */
export function persistentTmpEnv(env: NodeJS.ProcessEnv = process.env): PersistentTmpEnv {
  const active = Boolean(env[TEST_RUN_ENV]);
  const tmp = active ? env[TEST_RUN_ORIG_TMPDIR_ENV] : env.TMPDIR;
  const kiciTmp = active ? env[TEST_RUN_ORIG_KICI_TMPDIR_ENV] : env.KICI_TMPDIR;
  return {
    TMPDIR: tmp || undefined,
    KICI_TMPDIR: kiciTmp || undefined,
    [TEST_RUN_ENV]: undefined,
    [TEST_RUN_ORIG_TMPDIR_ENV]: undefined,
    [TEST_RUN_ORIG_KICI_TMPDIR_ENV]: undefined,
  };
}

/**
 * Loading a service's env file into its own environment at startup.
 *
 * A Windows service's command line is readable by every local account
 * (`sc.exe qc`, the service's registry key), so the Windows installer registers
 * the service with the env file's path in `KICI_ENV_FILE` and never its values.
 * The orchestrator and the agent import `./load-service-env-file.js` first,
 * which applies the file before any other module reads the environment.
 */

import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

/** The variable that names the env file a service loads at startup. */
export const SERVICE_ENV_FILE_VAR = 'KICI_ENV_FILE';

/** One `KEY=value` line of an env file. */
export interface EnvFileAssignment {
  key: string;
  value: string;
}

/**
 * Parse an env file. Each line is trimmed; blank lines, `#` comments, lines
 * with no `=` and lines with an empty key are skipped. The value is everything
 * after the first `=`, verbatim: no quote removal and no inline comments, so a
 * password that holds `#` or `=` arrives whole.
 */
export function parseServiceEnvFile(content: string): EnvFileAssignment[] {
  const assignments: EnvFileAssignment[] = [];
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    const key = eq > 0 ? trimmed.slice(0, eq).trim() : '';
    if (!key) continue;
    assignments.push({ key, value: trimmed.slice(eq + 1) });
  }
  return assignments;
}

/**
 * Prefixes of the variables the Node.js runtime and its libraries read as the
 * process starts (`NODE_OPTIONS`, `NODE_EXTRA_CA_CERTS`, `UV_THREADPOOL_SIZE`,
 * `OPENSSL_CONF`, `SSL_CERT_FILE`, …). A value set once the process runs does
 * not change how the running process behaves.
 */
const RUNTIME_STARTUP_PREFIXES = ['NODE_', 'UV_', 'OPENSSL_', 'SSL_CERT_'];

function isRuntimeStartupVar(key: string): boolean {
  const upper = key.toUpperCase();
  return RUNTIME_STARTUP_PREFIXES.some((prefix) => upper.startsWith(prefix));
}

export interface ApplyServiceEnvFileDeps {
  readFile: (filePath: string) => string;
  /** `;` on Windows, `:` elsewhere. */
  pathDelimiter: string;
  /**
   * Whether variable names ignore case, as on Windows, where the canonical
   * spelling of PATH is `Path`.
   */
  caseInsensitiveNames?: boolean;
}

/** What {@link applyServiceEnvFile} applied. */
export interface AppliedServiceEnvFile {
  /** The env file that was applied. */
  path: string;
  /**
   * The keys the file changed that the Node.js runtime reads only as the
   * process starts. The process must start again for them to take effect.
   */
  startupKeys: string[];
}

/**
 * Apply the env file `env.KICI_ENV_FILE` names to `env`, and remove
 * `KICI_ENV_FILE` so no child process inherits the pointer to this process's
 * secrets. Returns undefined when the variable is unset.
 *
 * An assignment overrides the inherited value, except `PATH`: its directories
 * go in front of the inherited PATH, which a service account needs for its own
 * system tools. Throws when the file cannot be read; the message names the
 * path and never the file's content.
 */
export function applyServiceEnvFile(
  env: NodeJS.ProcessEnv,
  deps: ApplyServiceEnvFileDeps,
): AppliedServiceEnvFile | undefined {
  const filePath = env[SERVICE_ENV_FILE_VAR]?.trim();
  delete env[SERVICE_ENV_FILE_VAR];
  if (!filePath) return undefined;

  let content: string;
  try {
    content = deps.readFile(filePath);
  } catch (err) {
    const reason = (err as NodeJS.ErrnoException).code ?? 'unreadable';
    throw new Error(
      `${SERVICE_ENV_FILE_VAR} names ${filePath}, which could not be read (${reason})`,
      { cause: err },
    );
  }

  const startupKeys: string[] = [];
  const nameOf = (key: string) => (deps.caseInsensitiveNames ? key.toUpperCase() : key);
  for (const { key, value } of parseServiceEnvFile(content)) {
    // The pointer is never applied, in any spelling: a child process would
    // inherit it and load this process's secrets.
    if (key.toUpperCase() === SERVICE_ENV_FILE_VAR) continue;
    if (nameOf(key) === 'PATH') {
      const dirs = value.split(deps.pathDelimiter).filter(Boolean);
      const inherited = env.PATH ? [env.PATH] : [];
      env.PATH = [...dirs, ...inherited].join(deps.pathDelimiter);
      continue;
    }
    if (isRuntimeStartupVar(key) && env[key] !== value) startupKeys.push(key);
    env[key] = value;
  }
  return { path: filePath, startupKeys };
}

/** Apply the env file `KICI_ENV_FILE` names to this process's environment. */
export function loadServiceEnvFile(): AppliedServiceEnvFile | undefined {
  return applyServiceEnvFile(process.env, {
    readFile: (filePath) => fs.readFileSync(filePath, 'utf-8'),
    pathDelimiter: path.delimiter,
    caseInsensitiveNames: process.platform === 'win32',
  });
}

/**
 * Whether the process must start again for the env file to take full effect:
 * on Windows, when the file changed a variable the Node.js runtime reads only
 * as it starts.
 *
 * Only on Windows, the one platform whose installer sets `KICI_ENV_FILE`. The
 * Linux and macOS service managers apply the env file before the process
 * starts, and there a second process could not pass on a signal sent to the
 * first one.
 */
export function mustRelaunch(
  applied: AppliedServiceEnvFile | undefined,
  platform: NodeJS.Platform,
): boolean {
  return platform === 'win32' && applied !== undefined && applied.startupKeys.length > 0;
}

export interface RelaunchDeps {
  spawnSync: (
    command: string,
    args: string[],
    options: { stdio: 'inherit'; env: NodeJS.ProcessEnv },
  ) => Pick<SpawnSyncReturns<Buffer>, 'status' | 'signal' | 'error'>;
  execPath: string;
  execArgv: string[];
  argv: string[];
  /** Keep `signal` from ending this process while the child runs. */
  ignoreSignal: (signal: NodeJS.Signals) => void;
}

const defaultRelaunchDeps: RelaunchDeps = {
  spawnSync: (command, args, options) => spawnSync(command, args, options),
  execPath: process.execPath,
  execArgv: process.execArgv,
  argv: process.argv,
  ignoreSignal: (signal) => {
    process.on(signal, () => {});
  },
};

/**
 * Run this process's command line again as a child with `env`, wait until the
 * child exits, and return its exit code.
 *
 * The wait blocks, so nothing else in this process runs. A Windows service stop
 * is a ctrl-C to every process on the service's console: the child receives it
 * directly and shuts down, while this process ignores it and exits with the
 * child's code once the child is gone.
 */
export function relaunchWithEnv(
  env: NodeJS.ProcessEnv,
  deps: RelaunchDeps = defaultRelaunchDeps,
): number {
  deps.ignoreSignal('SIGINT');
  deps.ignoreSignal('SIGBREAK');
  const result = deps.spawnSync(deps.execPath, [...deps.execArgv, ...deps.argv.slice(1)], {
    stdio: 'inherit',
    env,
  });
  if (result.error) {
    throw new Error(`could not start ${deps.execPath} again: ${result.error.message}`, {
      cause: result.error,
    });
  }
  return result.status ?? 1;
}

export interface ServiceEnvLoaderDeps {
  load: () => AppliedServiceEnvFile | undefined;
  platform: NodeJS.Platform;
  relaunch: () => number;
  exit: (code: number) => void;
  logError: (line: string) => void;
}

const defaultLoaderDeps: ServiceEnvLoaderDeps = {
  load: loadServiceEnvFile,
  platform: process.platform,
  relaunch: () => relaunchWithEnv(process.env),
  exit: (code) => process.exit(code),
  logError: (line) => console.error(line),
};

/**
 * Apply the env file `KICI_ENV_FILE` names, and start the process again when
 * {@link mustRelaunch} says so, exiting with the code of the process started.
 * An env file that cannot be read ends the process with code 1 and one line
 * that names the path: a service that started without its configuration would
 * run with defaults the operator never chose.
 */
export function runServiceEnvLoader(deps: ServiceEnvLoaderDeps = defaultLoaderDeps): void {
  try {
    const applied = deps.load();
    if (mustRelaunch(applied, deps.platform)) deps.exit(deps.relaunch());
  } catch (err) {
    deps.logError(`[kici] ${err instanceof Error ? err.message : String(err)}`);
    deps.exit(1);
  }
}

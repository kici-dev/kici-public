/**
 * Where the `kici-agent` binary installed with an orchestrator lives.
 *
 * The `kici-admin` npm package ships both the orchestrator and the `kici-agent`
 * bin, so `npm install -g kici-admin` puts the agent in the runtime's global bin
 * folder, and a bare-metal scaler whose `binaryPath` names that file upgrades
 * its agent together with the orchestrator. These helpers find the
 * file from a path inside the installed package: the service's entry script,
 * or the running process's own.
 */

import fs from 'node:fs';
import path from 'node:path';
import { ScalerBackendType } from '@kici-dev/engine';
import type { ScalerEntry } from './types.js';

/** The package whose global install provides the `kici-agent` bin. */
const AGENT_OWNING_PACKAGE = 'kici-admin';

function agentBinName(windows: boolean): string {
  return windows ? 'kici-agent.cmd' : 'kici-agent';
}

/**
 * The `kici-agent` bin that npm linked for the `kici-admin` package that
 * contains `entry`, or null when `entry` is not inside a `kici-admin` install.
 *
 * - POSIX global install (`<prefix>/lib/node_modules/kici-admin/…`):
 *   `<prefix>/bin/kici-agent`.
 * - Windows global install (`<prefix>\node_modules\kici-admin\…`):
 *   `<prefix>\kici-agent.cmd`.
 * - POSIX local install (`<dir>/node_modules/kici-admin/…`):
 *   `<dir>/node_modules/.bin/kici-agent`.
 */
export function agentBinaryFromEntry(entry: string, windows: boolean): string | null {
  const p = windows ? path.win32 : path.posix;
  const segments = entry.split(/[/\\]/);
  const idx = segments.indexOf('node_modules');
  if (idx < 1 || segments[idx + 1] !== AGENT_OWNING_PACKAGE) return null;
  // Keep a POSIX absolute path absolute: its first segment is the empty string.
  const root = segments.slice(0, idx).join(p.sep) || p.sep;
  if (windows) return p.join(root, agentBinName(true));
  if (segments[idx - 1] === 'lib') return p.join(p.dirname(root), 'bin', agentBinName(false));
  return p.join(root, 'node_modules', '.bin', agentBinName(false));
}

/**
 * The agent installed with the runtime a service launch command uses: the
 * first launch token inside a `kici-admin` install decides it.
 */
export function agentBinaryFromLaunch(
  launch: { execPath: string; args: string[] },
  windows: boolean,
): string | null {
  for (const token of [launch.execPath, ...launch.args]) {
    const found = agentBinaryFromEntry(token, windows);
    if (found) return found;
  }
  return null;
}

/** Whether `file` exists and this process may execute it. */
export function isExecutableFile(file: string): boolean {
  try {
    fs.accessSync(file, fs.constants.X_OK);
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

/** A version manager's own executable or shim that a `binaryPath` resolves to. */
export interface VersionManagerExecutable {
  /** The version manager, e.g. `mise`, or null when the shim names none. */
  manager: string | null;
  /** The file the `binaryPath` resolves to. */
  realpath: string;
  /** The command that prints the `kici-agent` the shim runs, or null. */
  whichCommand: string | null;
}

/**
 * Version-manager executables a shim links to, by file name, with the command
 * that prints the real tool behind a shim.
 */
const VERSION_MANAGER_EXECUTABLES: Record<string, { manager: string; which: string | null }> = {
  mise: { manager: 'mise', which: 'mise which kici-agent' },
  'volta-shim': { manager: 'Volta', which: 'volta which kici-agent' },
  volta: { manager: 'Volta', which: 'volta which kici-agent' },
  asdf: { manager: 'asdf', which: 'asdf which kici-agent' },
  nodenv: { manager: 'nodenv', which: 'nodenv which kici-agent' },
  fnm: { manager: 'fnm', which: null },
};

/** Version managers whose shims are scripts in a `shims` folder, by a path segment. */
const SHIM_SCRIPT_MANAGERS: Array<[RegExp, string]> = [
  [/[/\\]\.asdf[/\\]/, 'asdf'],
  [/[/\\]\.nodenv[/\\]/, 'nodenv'],
  [/[/\\]mise[/\\]/, 'mise'],
];

/**
 * The version manager `binaryPath` runs instead of a `kici-agent`, or null.
 *
 * A shim is not an agent: a mise shim links to the `mise` executable, a Volta
 * shim to `volta-shim`, and an asdf or nodenv shim is a script in a `shims`
 * folder. Each one passes an executable-file check. An alias into a Node.js
 * install (mise `node/24`) resolves to the real agent and is not reported here.
 */
export function versionManagerExecutable(binaryPath: string): VersionManagerExecutable | null {
  let real: string;
  try {
    real = fs.realpathSync(binaryPath);
  } catch {
    return null;
  }
  const known = VERSION_MANAGER_EXECUTABLES[path.basename(real).replace(/\.exe$/i, '')];
  if (known) return { manager: known.manager, realpath: real, whichCommand: known.which };
  if (path.basename(path.dirname(real)) !== 'shims') return null;
  const script = SHIM_SCRIPT_MANAGERS.find(([re]) => re.test(real));
  if (!script) return { manager: null, realpath: real, whichCommand: null };
  const manager = script[1];
  return { manager, realpath: real, whichCommand: VERSION_MANAGER_EXECUTABLES[manager]!.which };
}

/** The sentence that tells the operator which path to set instead of a shim. */
export function versionManagerRemedy(vm: VersionManagerExecutable): string {
  return vm.whichCommand
    ? `Set binaryPath to the path \`${vm.whichCommand}\` prints.`
    : 'Set binaryPath to the kici-agent file inside the Node.js install.';
}

/** Why a bare-metal `binaryPath` is a version-manager shim, in operator words. */
export function versionManagerShimMessage(
  binaryPath: string,
  vm: VersionManagerExecutable,
): string {
  const shim = vm.manager ? `a version-manager shim (${vm.manager})` : 'a version-manager shim';
  return (
    `binaryPath ${binaryPath} is ${shim}: it resolves to ${vm.realpath}, not to a ` +
    'kici-agent, so no agent can start.'
  );
}

/**
 * One error line per bare-metal `binaryPath` that resolves to a version
 * manager's executable or shim. The startup tools check adds these to its own
 * errors: such a file passes the executable check, and no agent would start.
 */
export function bareMetalVersionManagerErrors(entries: ScalerEntry[]): string[] {
  const errors: string[] = [];
  for (const entry of entries) {
    if (entry.type !== ScalerBackendType.enum['bare-metal']) continue;
    for (const ls of entry.labelSets) {
      const vm = ls.binaryPath ? versionManagerExecutable(ls.binaryPath) : null;
      if (!vm) continue;
      errors.push(
        `agent binary for bare-metal scaler "${entry.name}": ` +
          `${versionManagerShimMessage(ls.binaryPath!, vm)} ${versionManagerRemedy(vm)}`,
      );
    }
  }
  return errors;
}

function isAgentCandidate(file: string): boolean {
  return isExecutableFile(file) && versionManagerExecutable(file) === null;
}

/**
 * The hint the startup tools check appends when a bare-metal `binaryPath` is
 * missing, not executable, or a version-manager shim: the agent installed with
 * this orchestrator's own runtime, when one is on disk. Null when every
 * `binaryPath` is usable or no such agent exists.
 *
 * Candidates, in order: the agent npm linked for the `kici-admin` package the
 * process runs from (`entryPath`, the service's entry script), then
 * `kici-agent` beside the running Node.js binary (`execPath`).
 */
export function bareMetalAgentBinaryHint(
  entries: ScalerEntry[],
  opts: {
    entryPath: string | undefined;
    execPath: string;
    windows: boolean;
  },
): string | null {
  const failing = new Set<string>();
  for (const entry of entries) {
    if (entry.type !== ScalerBackendType.enum['bare-metal']) continue;
    for (const ls of entry.labelSets) {
      if (ls.binaryPath && !isAgentCandidate(ls.binaryPath)) failing.add(ls.binaryPath);
    }
  }
  if (failing.size === 0) return null;

  const p = opts.windows ? path.win32 : path.posix;
  const candidates = [
    opts.entryPath ? agentBinaryFromEntry(opts.entryPath, opts.windows) : null,
    p.join(p.dirname(opts.execPath), agentBinName(opts.windows)),
  ];
  const found = candidates.find(
    (c): c is string => c !== null && !failing.has(c) && isAgentCandidate(c),
  );
  if (!found) return null;
  return (
    `Hint: the kici-agent installed with this orchestrator's runtime is ${found}. ` +
    'Set the bare-metal binaryPath to that path in the scaler config, then restart the orchestrator.'
  );
}

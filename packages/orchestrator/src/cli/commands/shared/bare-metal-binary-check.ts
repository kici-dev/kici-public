/**
 * The bare-metal `binaryPath` check `kici-admin orchestrator upgrade` runs
 * before it installs or restarts anything.
 *
 * The restarted orchestrator refuses to start when a `binaryPath` is not an
 * executable file, or is a Node.js version-manager shim (a mise, Volta, asdf or
 * nodenv shim runs the version manager, not an agent). A missing file usually
 * comes from a version-manager alias (mise `node/24`) that moved to a new
 * runtime with no `kici-agent`, while the upgrade installs under the runtime
 * the service unit runs. The scaler config is read the way the service reads it.
 */

import fs from 'node:fs';
import path from 'node:path';
import { ScalerBackendType } from '@kici-dev/engine';
import { toErrorMessage } from '@kici-dev/shared';
import { loadScalerConfig } from '../../../scaler/config.js';
import {
  isExecutableFile,
  versionManagerExecutable,
  versionManagerRemedy,
  versionManagerShimMessage,
} from '../../../scaler/agent-binary-location.js';
import type { ScalerConfig } from '../../../scaler/types.js';
import { readEnvValue } from '../../service/backup-timer.js';

/** The upgrade flag that turns a refusal of this check into a warning. */
export const SKIP_BINARY_PATH_CHECK_FLAG = '--skip-binary-path-check';

/** What is wrong with one bare-metal `binaryPath`. */
export enum BinaryPathIssue {
  /** Not an executable file: the restarted orchestrator would not start. */
  Missing = 'missing',
  /** A version-manager shim, not a `kici-agent`: the restarted orchestrator would not start. */
  VersionManagerShim = 'version-manager-shim',
  /** Runs a `kici-agent` from another install than the service's runtime. */
  OtherInstall = 'other-install',
  /** Goes through a version-manager alias or shim that can move. */
  VersionManagerPath = 'version-manager-path',
  /** Runs the `kici-agent` of the Node.js runtime a `--node` upgrade moves the service away from. */
  PreviousRuntime = 'previous-runtime',
}

export interface BinaryPathFinding {
  issue: BinaryPathIssue;
  scaler: string;
  binaryPath: string;
  message: string;
}

type ConfiguredBinaryPath = Pick<BinaryPathFinding, 'scaler' | 'binaryPath'>;

/** Every distinct bare-metal `binaryPath` in a scaler config. */
function bareMetalBinaryPaths(config: ScalerConfig): ConfiguredBinaryPath[] {
  const seen = new Set<string>();
  const out: ConfiguredBinaryPath[] = [];
  for (const entry of config.scalers) {
    if (entry.type !== ScalerBackendType.enum['bare-metal']) continue;
    for (const ls of entry.labelSets) {
      if (!ls.binaryPath || seen.has(ls.binaryPath)) continue;
      seen.add(ls.binaryPath);
      out.push({ scaler: entry.name, binaryPath: ls.binaryPath });
    }
  }
  return out;
}

/** Whether a version-manager path runs the manager each time, or links to a runtime that can move. */
export enum VersionManagerPathType {
  /** Runs the version manager, which picks a runtime at each start. */
  Shim = 'shim',
  /** Links to one runtime until another one is installed or selected. */
  Alias = 'alias',
}

/**
 * The version-manager alias or shim `binaryPath` goes through, or null when
 * the path names a fixed runtime. `kind` is in words for the operator. Reads
 * the configured path, not its target: an alias resolves to the right file
 * until another runtime is installed.
 */
export function versionManagerPath(
  binaryPath: string,
): { kind: string; type: VersionManagerPathType } | null {
  const p = binaryPath.replace(/\\/g, '/');
  const miseInstall = /\/mise\/installs\/node\/([^/]+)\//.exec(p);
  if (miseInstall && !/^v?\d+\.\d+\.\d+$/.test(miseInstall[1]!)) {
    return { kind: `mise alias (node/${miseInstall[1]})`, type: VersionManagerPathType.Alias };
  }
  const kinds: Array<[RegExp, string, VersionManagerPathType]> = [
    [/\/mise\/shims\//, 'mise shim', VersionManagerPathType.Shim],
    [/\/\.asdf\/shims\//, 'asdf shim', VersionManagerPathType.Shim],
    [/\/\.volta\/bin\//, 'Volta shim', VersionManagerPathType.Shim],
    [/\/\.nodenv\/shims\//, 'nodenv shim', VersionManagerPathType.Shim],
    [/\/fnm_multishells\//, 'fnm shell link', VersionManagerPathType.Alias],
    [/\/fnm\/aliases\//, 'fnm alias', VersionManagerPathType.Alias],
    [/\/\.nvm\/current\//, 'nvm current link', VersionManagerPathType.Alias],
    [/\/shims\//, 'version-manager shim', VersionManagerPathType.Shim],
  ];
  for (const [re, kind, type] of kinds) {
    if (re.test(p)) return { kind, type };
  }
  return null;
}

/** The words {@link versionManagerPath} uses for `binaryPath`, or null for a fixed runtime. */
export function versionManagerPathKind(binaryPath: string): string | null {
  return versionManagerPath(binaryPath)?.kind ?? null;
}

/** `realpath`, or null when the file does not exist. */
function realpathOrNull(file: string): string | null {
  try {
    return fs.realpathSync(file);
  } catch {
    return null;
  }
}

/**
 * The `<name>@<version>` of the package that owns `file` (its realpath), read
 * from the nearest `package.json` above it. Null when no such file is found.
 */
export function owningPackageVersion(file: string): string | null {
  const real = realpathOrNull(file);
  if (!real) return null;
  let dir = path.dirname(real);
  for (;;) {
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf-8')) as {
        name?: unknown;
        version?: unknown;
      };
      if (typeof pkg.name === 'string' && typeof pkg.version === 'string') {
        return `${pkg.name}@${pkg.version}`;
      }
    } catch {
      // No readable package.json here: keep walking up.
    }
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

export interface CheckBinaryPathArgs {
  configured: Pick<BinaryPathFinding, 'scaler' | 'binaryPath'>;
  /** Resolves a relative `binaryPath`, as the service's working directory does. */
  workingDirectory: string;
  /**
   * The `kici-agent` installed with the service's runtime, or null when the
   * upgrade provides none (an archive install, a standalone package).
   */
  expectedAgent: string | null;
  /** What `expectedAgent` runs after the upgrade, e.g. `kici-admin@0.17.0`. */
  expectedVersion: string | null;
  /** True when the upgrade installs `expectedAgent` before it restarts. */
  willInstall: boolean;
  /**
   * The `kici-agent` of the runtime the service leaves, when the upgrade moves
   * it to another Node.js runtime (`--node`); null otherwise.
   */
  previousAgent?: string | null;
  /** The scaler config file, for the remedy text. */
  scalerConfigPath: string;
}

/**
 * Classify one `binaryPath`. An empty result means it resolves to the agent
 * installed with the service's runtime: the upgrade restarts onto it as is.
 */
export function checkBinaryPath(args: CheckBinaryPathArgs): BinaryPathFinding[] {
  const { configured, expectedAgent, expectedVersion, scalerConfigPath } = args;
  const { scaler, binaryPath } = configured;
  const resolved = path.resolve(args.workingDirectory, binaryPath);
  const finding = (issue: BinaryPathIssue, message: string): BinaryPathFinding => ({
    issue,
    scaler,
    binaryPath,
    message: `bare-metal scaler "${scaler}": ${message}`,
  });

  // The configured path is the agent the upgrade installs: correct even when
  // the file appears only once the install runs.
  if (
    expectedAgent &&
    resolved === expectedAgent &&
    (args.willInstall || isExecutableFile(resolved))
  ) {
    return [];
  }

  if (!isExecutableFile(resolved)) {
    // A binaryPath that already names the expected agent needs kici-admin
    // installed under the service's runtime, not a different path.
    const remedy =
      expectedAgent && resolved !== expectedAgent
        ? `Set binaryPath to ${expectedAgent}, the kici-agent installed with the service's runtime, in ${scalerConfigPath}.`
        : `Install kici-admin under the service's runtime, or set binaryPath to an installed kici-agent in ${scalerConfigPath}.`;
    return [
      finding(
        BinaryPathIssue.Missing,
        `binaryPath ${binaryPath} is not an executable file, so the restarted orchestrator would not start. ${remedy}`,
      ),
    ];
  }

  const shim = versionManagerExecutable(resolved);
  if (shim) {
    const remedy = expectedAgent
      ? `Set binaryPath to ${expectedAgent}, the kici-agent installed with the service's runtime, in ${scalerConfigPath}.`
      : `${versionManagerRemedy(shim).replace(/\.$/, '')}, in ${scalerConfigPath}.`;
    return [
      finding(
        BinaryPathIssue.VersionManagerShim,
        `${versionManagerShimMessage(binaryPath, shim)} The restarted orchestrator would not start. ${remedy}`,
      ),
    ];
  }

  const findings: BinaryPathFinding[] = [];
  const real = realpathOrNull(resolved) ?? resolved;
  const kind = versionManagerPathKind(binaryPath);
  if (kind) {
    const stable = expectedAgent ?? real;
    findings.push(
      finding(
        BinaryPathIssue.VersionManagerPath,
        `binaryPath ${binaryPath} goes through a ${kind}, which moves when another Node.js ` +
          `runtime is installed. Use a stable path: ${stable}.`,
      ),
    );
  }

  if (expectedAgent && args.previousAgent) {
    const previousReal = realpathOrNull(args.previousAgent) ?? args.previousAgent;
    if (real === previousReal) {
      findings.push(
        finding(
          BinaryPathIssue.PreviousRuntime,
          `binaryPath ${binaryPath} is the kici-agent of the Node.js runtime this upgrade moves ` +
            'the service away from, so each agent the scaler starts still runs on that runtime. ' +
            `Set binaryPath to ${expectedAgent} in ${scalerConfigPath}.`,
        ),
      );
      return findings;
    }
  }

  if (expectedAgent) {
    const expectedReal = realpathOrNull(expectedAgent) ?? expectedAgent;
    if (real !== expectedReal) {
      const runs = owningPackageVersion(resolved) ?? 'an unknown version';
      const will = expectedVersion ?? owningPackageVersion(expectedAgent) ?? 'an unknown version';
      findings.push(
        finding(
          BinaryPathIssue.OtherInstall,
          `binaryPath ${binaryPath} runs ${real} (${runs}), not the kici-agent installed with ` +
            `the service's runtime, ${expectedAgent} (${will}). Set binaryPath to ${expectedAgent} ` +
            'so the agent upgrades with the orchestrator.',
        ),
      );
    }
  }
  return findings;
}

/** The scaler config files an instance's env file names, resolved like the service does. */
export function scalerConfigLocation(
  envContent: string,
  workingDirectory: string,
): { configPath: string; configDir: string | undefined } | null {
  const configPath = readEnvValue(envContent, 'KICI_SCALER_CONFIG_PATH');
  // The service loads no scaler config without a path, even when a directory is set.
  if (!configPath) return null;
  const dir = readEnvValue(envContent, 'KICI_SCALER_CONFIG_DIR');
  return {
    configPath: path.resolve(workingDirectory, configPath),
    configDir: dir ? path.resolve(workingDirectory, dir) : undefined,
  };
}

/** The findings that stop an upgrade unless the check is skipped. */
function isRefusal(finding: BinaryPathFinding): boolean {
  return (
    finding.issue === BinaryPathIssue.Missing ||
    finding.issue === BinaryPathIssue.VersionManagerShim
  );
}

export interface PreflightArgs {
  serviceName: string;
  envFilePath: string;
  workingDirectory: string;
  expectedAgent: string | null;
  expectedVersion: string | null;
  willInstall: boolean;
  /** See {@link CheckBinaryPathArgs.previousAgent}. */
  previousAgent?: string | null;
  /** `--skip-binary-path-check`: report a refusal as a warning and go on. */
  skip: boolean;
  warn: (line: string) => void;
}

/**
 * Prints each warning, and throws when a `binaryPath` is not executable or is a
 * version-manager shim, unless `skip` is set. An unreadable scaler config is
 * reported and not checked: the service reads it again at its own startup.
 */
export async function preflightBareMetalBinaryPaths(args: PreflightArgs): Promise<void> {
  let envContent: string;
  try {
    envContent = fs.readFileSync(args.envFilePath, 'utf-8');
  } catch (err) {
    args.warn(
      `Warning: cannot read ${args.envFilePath} (${toErrorMessage(err)}), so the bare-metal ` +
        'binaryPath values were not checked.',
    );
    return;
  }
  const location = scalerConfigLocation(envContent, args.workingDirectory);
  if (!location) return;

  let config: ScalerConfig;
  try {
    config = await loadScalerConfig(location.configPath, location.configDir);
  } catch (err) {
    args.warn(
      `Warning: cannot read the scaler config ${location.configPath} (${toErrorMessage(err)}), ` +
        'so the bare-metal binaryPath values were not checked.',
    );
    return;
  }

  const findings = bareMetalBinaryPaths(config).flatMap((configured) =>
    checkBinaryPath({
      configured,
      workingDirectory: args.workingDirectory,
      expectedAgent: args.expectedAgent,
      expectedVersion: args.expectedVersion,
      willInstall: args.willInstall,
      previousAgent: args.previousAgent ?? null,
      scalerConfigPath: location.configPath,
    }),
  );
  const refusals = findings.filter(isRefusal);
  for (const f of findings) {
    if (!isRefusal(f) || args.skip) args.warn(`Warning: ${f.message}`);
  }
  if (refusals.length === 0 || args.skip) return;

  throw new Error(
    `refusing to upgrade "${args.serviceName}":\n` +
      refusals.map((f) => `  - ${f.message}`).join('\n') +
      '\nNothing was installed and the service was not restarted. Fix binaryPath and run the ' +
      `upgrade again, or pass ${SKIP_BINARY_PATH_CHECK_FLAG} to upgrade anyway.`,
  );
}

/**
 * Resolve the npm CLI path relative to the running Node.js binary.
 *
 * Used both at startup (builder role readiness check) and at install time
 * (dep-installer). Centralizes the resolution logic so it stays consistent.
 *
 * Resolution strategy:
 * 1. Check standard Node.js layout paths relative to process.execPath
 * 2. Fall back to bare 'npm' on PATH (development environments)
 */

import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { execFileSync } from 'node:child_process';

/** Result of npm resolution. */
interface NpmResolution {
  /** Absolute path to npm-cli.js, or undefined if using bare 'npm' from PATH. */
  npmCliPath: string | undefined;
  /** The Node.js executable path (process.execPath). */
  nodeExe: string;
  /** Directory containing the Node.js binary. */
  nodeDir: string;
}

/**
 * Resolve the npm CLI path from the current Node.js binary.
 *
 * Checks standard Node.js distribution layout paths:
 * - {nodeDir}/../lib/node_modules/npm/bin/npm-cli.js (Linux/macOS installed)
 * - {nodeDir}/node_modules/npm/bin/npm-cli.js (Windows / some layouts)
 *
 * Returns undefined npmCliPath if neither is found (caller can fall back to PATH).
 */
export function resolveNpm(): NpmResolution {
  const nodeExe = process.execPath;
  const nodeDir = dirname(nodeExe);
  const candidates = [
    join(nodeDir, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    join(nodeDir, 'node_modules', 'npm', 'bin', 'npm-cli.js'),
  ];
  const npmCliPath = candidates.find((p) => existsSync(p));
  return { npmCliPath, nodeExe, nodeDir };
}

/**
 * Verify that npm is usable by running `npm --version`.
 *
 * Called at agent startup when the builder role is active.
 * Throws a descriptive error if npm cannot be executed.
 *
 * @returns The npm version string (e.g., "10.8.1")
 */
export function verifyNpmAvailable(): string {
  const { npmCliPath, nodeExe, nodeDir } = resolveNpm();

  const env = {
    ...process.env,
    PATH: `${nodeDir}${process.platform === 'win32' ? ';' : ':'}${process.env.PATH ?? ''}`,
  };

  try {
    let output: string;
    if (npmCliPath) {
      output = execFileSync(nodeExe, [npmCliPath, '--version'], {
        env,
        timeout: 10_000,
        stdio: 'pipe',
        encoding: 'utf-8',
      });
    } else {
      output = execFileSync('npm', ['--version'], {
        env,
        timeout: 10_000,
        stdio: 'pipe',
        encoding: 'utf-8',
      });
    }
    return output.trim();
  } catch (err) {
    const hint = npmCliPath
      ? `npm-cli.js found at ${npmCliPath} but failed to execute`
      : 'npm not found relative to Node binary or on PATH';
    throw new Error(
      `Builder role requires npm but it is not available. ${hint}. ` +
        `Ensure the Node.js distribution includes npm, or install npm and add it to PATH. ` +
        `(Node binary: ${nodeExe})`,
      { cause: err },
    );
  }
}

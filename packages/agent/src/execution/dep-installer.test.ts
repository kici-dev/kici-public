import { describe, it, expect } from 'vitest';
import { PackageManager, YarnFlavor } from '@kici-dev/shared/package-manager';
import {
  buildYarnBerryInstallArgs,
  buildYarnInstallArgs,
  siblingBuildCommand,
} from './dep-installer.js';

describe('buildYarnInstallArgs', () => {
  it('omits --ignore-scripts under the operator opt-out', () => {
    expect(buildYarnInstallArgs('/tmp/cache', false)).toEqual([
      'install',
      '--cache-folder',
      '/tmp/cache',
      '--non-interactive',
      '--no-progress',
    ]);
  });

  it('adds --ignore-scripts when lifecycle scripts are disabled', () => {
    expect(buildYarnInstallArgs('/tmp/cache', true)).toEqual([
      'install',
      '--cache-folder',
      '/tmp/cache',
      '--non-interactive',
      '--no-progress',
      '--ignore-scripts',
    ]);
  });
});

describe('buildYarnBerryInstallArgs', () => {
  it('is a bare `yarn install` (cache + linker come from .yarnrc.yml)', () => {
    expect(buildYarnBerryInstallArgs()).toEqual(['install']);
  });
});

describe('siblingBuildCommand', () => {
  const base = { repoRoot: '/r', sibDir: '/r/packages/u', nodeExe: '/n/node' };

  it('runs an npm sibling build from its own directory through the bundled npm', () => {
    // fails-when: npm siblings are never built, so a workflow importing one fails
    // to load on the agent with no dist/
    expect(
      siblingBuildCommand({
        ...base,
        packageManager: PackageManager.Npm,
        yarnFlavor: YarnFlavor.Classic,
        npmCliPath: '/n/npm-cli.js',
      }),
    ).toEqual({ bin: '/n/node', argv: ['/n/npm-cli.js', 'run', 'build'], cwd: '/r/packages/u' });
  });

  it('falls back to npm on PATH', () => {
    expect(
      siblingBuildCommand({
        ...base,
        packageManager: PackageManager.Npm,
        yarnFlavor: YarnFlavor.Classic,
        npmCliPath: undefined,
      }),
    ).toEqual({ bin: 'npm', argv: ['run', 'build'], cwd: '/r/packages/u' });
  });

  it('keeps the yarn classic and berry forms', () => {
    // breaks-if-wrong: the yarn sibling builds keep their exact argv (no extra arg reaches the script)
    expect(
      siblingBuildCommand({
        ...base,
        packageManager: PackageManager.Yarn,
        yarnFlavor: YarnFlavor.Classic,
        npmCliPath: undefined,
      }),
    ).toEqual({ bin: 'yarn', argv: ['--cwd', '/r/packages/u', 'run', 'build'], cwd: '/r' });
    expect(
      siblingBuildCommand({
        ...base,
        packageManager: PackageManager.Yarn,
        yarnFlavor: YarnFlavor.Berry,
        npmCliPath: undefined,
      }),
    ).toEqual({ bin: 'yarn', argv: ['run', 'build'], cwd: '/r/packages/u' });
  });
});

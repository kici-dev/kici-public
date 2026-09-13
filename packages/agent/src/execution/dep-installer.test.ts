import { describe, it, expect } from 'vitest';
import { buildYarnBerryInstallArgs, buildYarnInstallArgs } from './dep-installer.js';

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

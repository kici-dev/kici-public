import { afterAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { VersionPin, npmrcRequestsExactVersions, resolveVersionPin } from '../version-pin.js';

/** `.npmrc` text, and whether npm saves exact versions under it. */
const CASES: ReadonlyArray<readonly [npmrc: string, exact: boolean]> = [
  ['', false],
  ['registry=https://registry.npmjs.org/\n', false],
  ['save-exact=true\n', true],
  ['save-exact = true\n', true],
  ['save-exact=true\r\n', true],
  ['save-exact\n', true],
  ['save-exact=0\n', true],
  ['save-exact=true # note\n', true],
  ['save-exact=false\n', false],
  ["save-exact='false'\n", false],
  ['save-exact=false ; note\n', false],
  ['save-exact=null\n', false],
  ['save-exact=true\nsave-exact=false\n', false],
  ['SAVE-EXACT=true\n', false],
  ['# save-exact=true\n', false],
  ['  ; save-exact=true\n', false],
  ['[section]\nsave-exact=true\n', false],
  ['save-prefix=\n', true],
  ["save-prefix=''\n", true],
  ['save-prefix=""\n', true],
  ['save-prefix= # empty\n', true],
  ['save-prefix\n', false],
  ['save-prefix=~\n', false],
  ['save-prefix=~ # tilde\n', false],
  ["save-prefix='~' ; c\n", false],
];

const scratch = mkdtempSync(path.join(os.tmpdir(), 'kici-version-pin-'));
// npm refuses one file loaded as both the user and the global config.
const emptyUserConfig = path.join(scratch, 'empty-user.npmrc');
const emptyGlobalConfig = path.join(scratch, 'empty-global.npmrc');
writeFileSync(emptyUserConfig, '');
writeFileSync(emptyGlobalConfig, '');

afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});

/** What the installed npm decides for this project `.npmrc`: an empty save-prefix means exact. */
function npmSavesExact(npmrc: string, index: number): boolean {
  const dir = path.join(scratch, `case-${index}`);
  mkdirSync(dir);
  writeFileSync(path.join(dir, 'package.json'), '{}\n');
  writeFileSync(path.join(dir, '.npmrc'), npmrc);
  // Drop inherited npm settings (pnpm exports npm_config_* to scripts) so the
  // project file is the only source.
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !/^npm_config_/i.test(key)),
  );
  const prefix = execFileSync('npm', ['config', 'get', 'save-prefix'], {
    cwd: dir,
    env: {
      ...env,
      npm_config_userconfig: emptyUserConfig,
      npm_config_globalconfig: emptyGlobalConfig,
    },
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return prefix.trim() === '';
}

describe('npmrcRequestsExactVersions', () => {
  it.each(CASES)('%j -> exact=%s', (npmrc, exact) => {
    expect(npmrcRequestsExactVersions(npmrc)).toBe(exact);
  });

  it('agrees with the installed npm on every case', () => {
    const disagreements = CASES.map(([npmrc], i) => ({
      npmrc,
      ours: npmrcRequestsExactVersions(npmrc),
      npm: npmSavesExact(npmrc, i),
    })).filter((c) => c.ours !== c.npm);
    // fails-when: the reader drifts from npm's parser, e.g. it keeps an inline
    // `; note` comment and reads `save-exact=false ; note` as exact
    expect(disagreements).toEqual([]);
  }, 60_000);
});

describe('resolveVersionPin', () => {
  function repoWith(npmrc?: string): string {
    const dir = mkdtempSync(path.join(scratch, 'repo-'));
    if (npmrc !== undefined) writeFileSync(path.join(dir, '.npmrc'), npmrc);
    return dir;
  }

  it('is Caret without a repository .npmrc', async () => {
    expect(await resolveVersionPin(false, repoWith())).toBe(VersionPin.Caret);
  });

  it('is Exact when the repository .npmrc sets save-exact', async () => {
    // fails-when: the reader looks at a different file than <repoRoot>/.npmrc
    expect(await resolveVersionPin(false, repoWith('save-exact=true\n'))).toBe(VersionPin.Exact);
  });

  it('is Latest in development mode, whatever the .npmrc says', async () => {
    // breaks-if-wrong: dev builds are registry prereleases that no semver range
    // reaches, so dev mode must keep the `latest` dist-tag
    expect(await resolveVersionPin(true, repoWith('save-exact=true\n'))).toBe(VersionPin.Latest);
  });
});

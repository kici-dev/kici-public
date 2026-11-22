import { afterEach, describe, expect, it, vi } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';
import { createHermeticGit } from './hermetic-git.js';

const roots: string[] = [];

afterEach(() => {
  vi.unstubAllEnvs();
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A repository holding `x.txt`, and a config home whose global attributes and excludes match it. */
function setup(): { repo: string; configHome: string; emptyGlobal: string } {
  const root = mkdtempSync(join(os.tmpdir(), 'kici-hermetic-git-'));
  roots.push(root);
  const emptyGlobal = join(root, 'gitconfig');
  writeFileSync(emptyGlobal, '');
  const configHome = join(root, 'config');
  mkdirSync(join(configHome, 'git'), { recursive: true });
  writeFileSync(join(configHome, 'git', 'attributes'), '*.txt text=auto eol=crlf\n');
  writeFileSync(join(configHome, 'git', 'ignore'), 'x.txt\n');
  const repo = join(root, 'repo');
  execFileSync('git', ['init', '-q', repo]);
  writeFileSync(join(repo, 'x.txt'), 'x\n');
  return { repo, configHome, emptyGlobal };
}

/** The ways git finds the global attributes and excludes files when `core.*File` is unset. */
const LOCATIONS: Array<[string, (configHome: string) => Record<string, string | undefined>]> = [
  ['$XDG_CONFIG_HOME/git', (configHome) => ({ XDG_CONFIG_HOME: configHome })],
  [
    '$HOME/.config/git',
    (configHome) => ({ XDG_CONFIG_HOME: undefined, HOME: join(configHome, '..', 'home') }),
  ],
];

describe('createHermeticGit', () => {
  it.each(LOCATIONS)('reads no global attributes or excludes file from %s', (_where, envFor) => {
    const { repo, configHome, emptyGlobal } = setup();
    const env = envFor(configHome);
    if (env.HOME) {
      cpSync(join(configHome, 'git'), join(env.HOME, '.config', 'git'), { recursive: true });
    }
    const devEnv: NodeJS.ProcessEnv = { ...process.env, GIT_CONFIG_GLOBAL: emptyGlobal, ...env };
    if (env.XDG_CONFIG_HOME === undefined) delete devEnv.XDG_CONFIG_HOME;

    // Positive control: the developer's git reads both files from this location.
    const devGit = (args: string[]) =>
      spawnSync('git', args, { cwd: repo, env: devEnv, encoding: 'utf8' });
    expect(devGit(['check-attr', 'text', 'x.txt']).stdout).toBe('x.txt: text: auto\n');
    expect(devGit(['ls-files', '--others', '--exclude-standard']).stdout).toBe('');

    for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);
    const git = createHermeticGit({ scratchDir: join(repo, '..', 'scratch') });
    // fails-when: the hermetic git falls back to the developer's global attributes or excludes file
    expect(git.run(['check-attr', 'text', 'x.txt'], { cwd: repo })).toBe(
      'x.txt: text: unspecified\n',
    );
    expect(git.run(['ls-files', '--others', '--exclude-standard'], { cwd: repo })).toBe('x.txt\n');
    // breaks-if-wrong: the repository's own .gitattributes still applies
    writeFileSync(join(repo, '.gitattributes'), '*.txt text\n');
    expect(git.run(['check-attr', 'text', 'x.txt'], { cwd: repo })).toBe('x.txt: text: set\n');
  });
});

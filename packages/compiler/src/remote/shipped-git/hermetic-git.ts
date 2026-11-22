/**
 * A git runner isolated from the developer's setup: no system or global config, global
 * attributes or excludes, inherited `GIT_*`, hooks, signing, reflogs or automatic maintenance.
 * The shipped `.git` is built with it, as a default-config git on the agent; the repository's
 * own `.gitattributes` still applies, as in a fresh clone.
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export interface HermeticGit {
  run(
    args: string[],
    opts?: { cwd?: string; env?: Record<string, string>; input?: string },
  ): string;
}

/** Large enough for `ls-tree -r` of a big monorepo. */
const MAX_BUFFER = 256 * 1024 * 1024;

const FIXED_FLAGS = [
  '-c',
  'protocol.file.allow=always',
  '-c',
  'core.logAllRefUpdates=false',
  '-c',
  'gc.auto=0',
  '-c',
  'maintenance.auto=false',
  '-c',
  'commit.gpgSign=false',
  '-c',
  'tag.gpgSign=false',
  '-c',
  'core.hooksPath=/dev/null',
  // Unset, they default to `$XDG_CONFIG_HOME/git/{attributes,ignore}`, which the empty global
  // config does not stop; the remote checkout reads neither.
  '-c',
  'core.attributesFile=/dev/null',
  '-c',
  'core.excludesFile=/dev/null',
];

function hermeticEnv(globalConfig: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && !key.startsWith('GIT_')) env[key] = value;
  }
  env.GIT_CONFIG_NOSYSTEM = '1';
  env.GIT_CONFIG_GLOBAL = globalConfig;
  env.GIT_TERMINAL_PROMPT = '0';
  // A partial clone never lazy-fetches its missing objects, whatever the git version's default.
  env.GIT_NO_LAZY_FETCH = '1';
  return env;
}

export function createHermeticGit(args: { scratchDir: string }): HermeticGit {
  mkdirSync(args.scratchDir, { recursive: true });
  const globalConfig = path.join(args.scratchDir, 'empty-gitconfig');
  writeFileSync(globalConfig, '');
  const baseEnv = hermeticEnv(globalConfig);

  return {
    run(gitArgs, opts) {
      return execFileSync('git', [...FIXED_FLAGS, ...gitArgs], {
        cwd: opts?.cwd,
        env: { ...baseEnv, ...opts?.env },
        input: opts?.input,
        encoding: 'utf8',
        maxBuffer: MAX_BUFFER,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    },
  };
}

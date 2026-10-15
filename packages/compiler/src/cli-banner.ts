import type { Command } from 'commander';

/**
 * `--json` and `--quiet` keep stdout free of chrome so callers can parse it. A
 * flag anywhere in the chain suppresses the banner. Each command's OWN opts are
 * read, not `optsWithGlobals()`, under which the `--quiet` default `kici run`
 * defines would mask `kici run remote --quiet`.
 */
export function shouldSuppressBanner(actionCommand: Command): boolean {
  let cmd: Command | null = actionCommand;
  while (cmd) {
    const opts = cmd.opts();
    if (opts.json === true || opts.quiet === true) return true;
    cmd = cmd.parent;
  }
  return false;
}

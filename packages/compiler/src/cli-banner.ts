import type { Command } from 'commander';

/**
 * Whether the version banner should be suppressed for the command about to run.
 *
 * Structured-output (`--json`) and quiet (`--quiet`) invocations must keep stdout
 * free of human-facing chrome so callers can parse stdout directly. Walks the
 * command chain checking each command's OWN opts (not `optsWithGlobals()`): a
 * flag set anywhere in the chain suppresses the banner, and reading own opts
 * avoids a parent's default value shadowing a subcommand's explicit flag —
 * `kici run` defines `--quiet` for its routed action, which under
 * `optsWithGlobals()` would mask `kici run remote --quiet`.
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

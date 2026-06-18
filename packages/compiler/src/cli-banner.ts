import type { Command } from 'commander';

/**
 * Whether the version banner should be suppressed for the command about to run.
 *
 * Structured-output (`--json`) and quiet (`--quiet`) invocations must keep stdout
 * free of human-facing chrome so callers can parse stdout directly. Uses
 * `optsWithGlobals()` so the check stays correct if either flag is ever promoted
 * to a global option.
 */
export function shouldSuppressBanner(actionCommand: Command): boolean {
  const opts = actionCommand.optsWithGlobals();
  return Boolean(opts.json) || Boolean(opts.quiet);
}

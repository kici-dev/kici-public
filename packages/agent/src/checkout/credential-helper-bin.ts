/**
 * The executable git spawns as `credential.helper`.
 *
 * Deliberately minimal: read stdin, forward to the agent over its local socket,
 * write stdout. No state, no decisions, no logging — anything it printed would
 * risk putting a token in a log, and git treats unexpected stdout as part of
 * the credential reply.
 *
 * Every failure mode answers with an EMPTY reply rather than a non-zero exit:
 * git then falls through to its own mechanisms and reports a normal
 * authentication failure, instead of the helper turning a recoverable miss into
 * a crash mid-push.
 */

import { parseCredentialInput, formatCredentialOutput } from './credential-helper.js';

export interface HelperDeps {
  /** Round-trip to the agent over its local socket. */
  send: (query: {
    protocol?: string;
    host?: string;
    path?: string;
  }) => Promise<{ kind: string; user?: string; secret: string } | null>;
}

/** Testable core. `argv` is git's operation word: `get`, `store`, or `erase`. */
export async function runHelperMain(
  argv: readonly string[],
  stdin: string,
  deps: HelperDeps,
): Promise<string> {
  const operation = argv[0];
  // We persist nothing, so `store` and `erase` have nothing to do. Erroring
  // here would break pushes that are otherwise working.
  if (operation !== 'get') return '';

  try {
    const credential = await deps.send(parseCredentialInput(stdin));
    if (!credential) return '';
    return formatCredentialOutput({
      username: credential.user ?? 'x-access-token',
      password: credential.secret,
    });
  } catch {
    return '';
  }
}

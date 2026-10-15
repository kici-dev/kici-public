/**
 * The executable git spawns as `credential.helper`: stdin → agent socket → stdout.
 * No state, no decisions, no logging — a printed line risks a token in a log, and
 * git reads unexpected stdout as part of the credential reply.
 *
 * Every failure answers with an EMPTY reply, never a non-zero exit, so git falls
 * through to its own mechanisms and reports a normal auth failure instead of a
 * crash mid-push.
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
  // Nothing is persisted, so `store`/`erase` are no-ops; erroring would break working pushes.
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

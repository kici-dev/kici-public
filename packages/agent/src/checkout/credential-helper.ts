/**
 * Git credential-helper protocol, agent side.
 *
 * Git invokes the helper on EVERY network operation, which defeats the one-hour
 * GitHub App token expiry: a token is minted seconds before use and never
 * persisted to `.git/config`, the step environment, or a log.
 *
 * Read-only by default; an elevated credential is served only while a write
 * grant covers the repository git is contacting.
 */

import type { GrantTable } from './grant-table.js';

export interface CredentialQuery {
  protocol?: string;
  host?: string;
  path?: string;
}

export interface CredentialReply {
  username: string;
  password: string;
}

/** Parse git's `key=value\n…\n\n` block. Unknown or malformed lines are skipped. */
export function parseCredentialInput(stdin: string): CredentialQuery {
  const query: CredentialQuery = {};
  for (const line of stdin.split('\n')) {
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq);
    const value = line.slice(eq + 1);
    if (key === 'protocol' || key === 'host' || key === 'path') query[key] = value;
  }
  return query;
}

/** Same `key=value` form. */
export function formatCredentialOutput(reply: CredentialReply): string {
  return `username=${reply.username}\npassword=${reply.password}\n`;
}

/** `owner/repo.git` (or `/owner/repo`) as git spells it -> `owner/repo`. */
function repositoryFromPath(path: string | undefined): string {
  return (path ?? '').replace(/^\/+/, '').replace(/\.git$/, '');
}

export interface ServeCredentialDeps {
  grants: GrantTable;
  /** Orchestrator broker round-trip; null when there is no credential. */
  request: (args: {
    repository: string;
    permissions: Readonly<Record<string, string>>;
  }) => Promise<{ kind: string; user?: string; secret: string } | null>;
}

/**
 * Answer one `get`. An empty string (no credential) lets git fall through to
 * its own mechanisms instead of failing.
 */
export async function serveCredential(
  query: CredentialQuery,
  deps: ServeCredentialDeps,
): Promise<string> {
  const repository = repositoryFromPath(query.path);
  const grant = deps.grants.lookup(repository);
  const permissions = grant ? grant.permissions : { contents: 'read' };

  const credential = await deps.request({ repository, permissions });
  if (!credential) return '';

  return formatCredentialOutput({
    username: credential.user ?? 'x-access-token',
    password: credential.secret,
  });
}

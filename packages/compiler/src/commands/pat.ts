import pc from 'picocolors';
import { toErrorMessage } from '@kici-dev/core';
import { PatKind } from '@kici-dev/engine';
import { loadGlobalConfig } from '../remote/config.js';

export interface PatCreateOptions {
  /** Token name shown in the dashboard PAT list. Defaults to the agent label. */
  name?: string;
  /** Mint an agent-kind PAT (the only credential the developer MCP server accepts). */
  agent?: boolean;
  /**
   * Agent label (required with `--agent`) — the human-set name recorded on every
   * audit row the agent produces. Also used as the token name when `--name` is
   * omitted.
   */
  label?: string;
  /** Custom expiry in days (server default: 120). */
  expiresInDays?: number;
  /** Injected fetch for tests. Defaults to the global fetch. */
  fetchImpl?: typeof fetch;
}

interface CreatePatResponse {
  id: string;
  token: string;
  name: string;
  expiresAt: string;
}

/**
 * Mint a personal access token under the logged-in user's identity.
 *
 * `kici pat create --agent --name <label>` mints an agent-kind PAT: it inherits
 * the user's permissions (provenance only, no authority change), carries its
 * label into every audit row, and is the credential a coding agent points the
 * KiCI developer MCP server at. The token is printed once — there is no way to
 * retrieve it later.
 */
export async function patCreateCommand(options: PatCreateOptions = {}): Promise<boolean> {
  const doFetch = options.fetchImpl ?? fetch;
  try {
    const config = await loadGlobalConfig();
    const token = config.pat ?? config.token;
    const endpoint = config.platformEndpoint ?? config.endpoint;
    if (!token || !endpoint) {
      console.error(pc.red('Not logged in. Run `kici login` first.'));
      return false;
    }

    const kind = options.agent ? PatKind.enum.agent : PatKind.enum.user;
    const label = options.label;
    if (kind === PatKind.enum.agent && !label) {
      console.error(pc.red('An agent PAT requires a label. Pass --name <label>.'));
      return false;
    }
    const name = options.name ?? label;
    if (!name) {
      console.error(pc.red('A token name is required. Pass --name <name>.'));
      return false;
    }

    const body: Record<string, unknown> = { name, kind };
    if (kind === PatKind.enum.agent) body.agentLabel = label;
    if (options.expiresInDays !== undefined) body.expiresInDays = options.expiresInDays;

    const res = await doFetch(`${endpoint.replace(/\/$/, '')}/api/v1/pats`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      let detail: string | undefined;
      try {
        detail = ((await res.json()) as { error?: string }).error;
      } catch {
        /* ignore non-JSON body */
      }
      console.error(pc.red(`Failed to create token (${res.status}): ${detail ?? 'request failed'}`));
      return false;
    }

    const created = (await res.json()) as CreatePatResponse;
    console.log(pc.bold(kind === PatKind.enum.agent ? '\nAgent PAT created.\n' : '\nPAT created.\n'));
    console.log(`${pc.gray('Name:   ')}${created.name}`);
    if (kind === PatKind.enum.agent) console.log(`${pc.gray('Agent:  ')}${label}`);
    console.log(`${pc.gray('Expires:')} ${created.expiresAt}`);
    console.log(`\n${pc.gray('Token (shown once — save it now):')}`);
    console.log(pc.cyan(created.token));
    if (kind === PatKind.enum.agent) {
      console.log(
        pc.gray(
          '\nPoint your coding agent at the KiCI MCP server with this token as the Bearer credential.',
        ),
      );
    }
    return true;
  } catch (err: unknown) {
    console.error(pc.red(`Failed to create token: ${toErrorMessage(err)}`));
    return false;
  }
}

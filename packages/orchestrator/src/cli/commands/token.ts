/** `kici-admin token create | list | revoke` for admin API tokens. */

import type { Command } from 'commander';
import type { AdminApiClient } from '../api-client.js';
import { cliAction } from './shared/cli-action.js';

/**
 * `--expires` as an absolute Date: `<N>d`, `<N>h` or `<N>m` from now, or an
 * ISO-8601 datetime. Anything else throws, so a typo never creates a
 * non-expiring token.
 */
export function parseExpiresAt(input: string, now: Date = new Date()): Date {
  const durationMatch = /^(\d+)([dhm])$/.exec(input.trim());
  if (durationMatch) {
    const value = Number(durationMatch[1]);
    const unitMs = { d: 86_400_000, h: 3_600_000, m: 60_000 }[durationMatch[2] as 'd' | 'h' | 'm'];
    if (value <= 0) throw new Error(`--expires duration must be positive: "${input}"`);
    const result = new Date(now.getTime() + value * unitMs);
    if (Number.isNaN(result.getTime())) {
      throw new Error(`--expires duration is too large: "${input}"`);
    }
    return result;
  }
  const asDate = new Date(input);
  if (Number.isNaN(asDate.getTime())) {
    throw new Error(
      `--expires must be a duration (e.g. "30d", "12h", "45m") or an ISO-8601 datetime: "${input}"`,
    );
  }
  return asDate;
}

export function formatTokenTable(tokens: any[]): string {
  if (tokens.length === 0) return 'No tokens found.';

  const header =
    'ID | Label | Role | Subject | RoutingKey | Created | Expires | LastUsed | Revoked';
  const sep = '-'.repeat(header.length);
  const now = Date.now();
  const rows = tokens.map((t: any) => {
    const id = t.id ?? '-';
    const label = t.label ?? '-';
    const role = t.role ?? '-';
    // `unlinked`, not `-`: it names the condition the RBAC drift report looks for.
    const subject = t.subject ?? 'unlinked';
    const rk = t.routingKey ?? t.routing_key ?? '-';
    const created = t.createdAt ?? t.created_at ?? '-';
    const expiresRaw = t.expiresAt ?? t.expires_at ?? null;
    const expires = expiresRaw
      ? new Date(expiresRaw).getTime() <= now
        ? `${expiresRaw} [expired]`
        : String(expiresRaw)
      : 'never';
    const lastUsed = t.lastUsedAt ?? t.last_used_at ?? '-';
    const revoked = t.revoked ?? false;
    return `${id} | ${label} | ${role} | ${subject} | ${rk} | ${created} | ${expires} | ${lastUsed} | ${revoked}`;
  });
  return [header, sep, ...rows].join('\n');
}

export function registerTokenCommands(program: Command, getClient: () => AdminApiClient): void {
  const tok = program.command('token').description('Manage admin API tokens');

  tok
    .command('create <label>')
    .description('Create a new admin API token')
    .requiredOption('--role <role>', 'Token role (owner, admin, auditor)')
    .option(
      '--routing-key <key>',
      'Restrict the token to a single source routing key (e.g. "github:42"). The token can only act on requests targeting that routing key, and is refused (403) on every secret route -- the secret store has no per-routing-key slice, so secrets need an unscoped token. Without this, the token has full orchestrator access.',
    )
    .option(
      '--expires <value>',
      'Optional expiry: a duration from now ("30d", "12h", "45m") or an ISO-8601 datetime. Omit for a non-expiring token.',
    )
    .option(
      '--subject <id>',
      'Record the intended holder of this token -- an OIDC subject or an email address. Advisory metadata: the orchestrator cannot verify it and never reads it when authorizing a request. It is what lets the dashboard RBAC drift report say whose token this is; a token created without it is reported as unlinked.',
    )
    .action(
      cliAction(
        async (
          label: string,
          opts: { role: string; routingKey?: string; expires?: string; subject?: string },
        ) => {
          const expiresAt = opts.expires ? parseExpiresAt(opts.expires).toISOString() : undefined;
          const result = await getClient().createToken({
            label,
            role: opts.role,
            routingKey: opts.routingKey,
            expiresAt,
            subject: opts.subject,
          });
          console.log(`Token created: ${result.token}`);
          console.log(`Token ID: ${result.id}`);
          console.log('Save this token -- it will not be shown again.');
        },
      ),
    );

  tok
    .command('list')
    .description('List all admin API tokens')
    .action(
      cliAction(async () => {
        const tokens = await getClient().listTokens();
        console.log(formatTokenTable(tokens));
      }),
    );

  tok
    .command('revoke <id>')
    .description('Revoke an admin API token')
    .action(
      cliAction(async (id: string) => {
        await getClient().revokeToken(id);
        console.log(`Token ${id} revoked.`);
      }),
    );
}

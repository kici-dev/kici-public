/**
 * Token management commands for kici-admin.
 *
 * Provides CRUD operations for admin API tokens:
 *   token create, list, revoke
 */

import type { Command } from 'commander';
import type { AdminApiClient } from '../api-client.js';
import { toErrorMessage } from '@kici-dev/shared';

/**
 * Parse a `--expires` value into an absolute expiry Date.
 *
 * Accepts either a duration shorthand relative to now (`<N>d` days,
 * `<N>h` hours, `<N>m` minutes — e.g. `30d`, `12h`, `45m`) or an
 * absolute ISO-8601 datetime (e.g. `2026-12-31T00:00:00Z`). Throws on any
 * other input so a typo never silently creates a non-expiring token.
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

/**
 * Format tokens as a table.
 */
function formatTokenTable(tokens: any[]): string {
  if (tokens.length === 0) return 'No tokens found.';

  const header = 'ID | Label | Role | RoutingKey | Created | Expires | LastUsed | Revoked';
  const sep = '-'.repeat(header.length);
  const now = Date.now();
  const rows = tokens.map((t: any) => {
    const id = t.id ?? '-';
    const label = t.label ?? '-';
    const role = t.role ?? '-';
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
    return `${id} | ${label} | ${role} | ${rk} | ${created} | ${expires} | ${lastUsed} | ${revoked}`;
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
    .action(
      async (label: string, opts: { role: string; routingKey?: string; expires?: string }) => {
        try {
          const expiresAt = opts.expires ? parseExpiresAt(opts.expires).toISOString() : undefined;
          const result = await getClient().createToken({
            label,
            role: opts.role,
            routingKey: opts.routingKey,
            expiresAt,
          });
          console.log(`Token created: ${result.token}`);
          console.log(`Token ID: ${result.id}`);
          console.log('Save this token -- it will not be shown again.');
        } catch (err) {
          console.error(`Error: ${toErrorMessage(err)}`);
          process.exit(1);
        }
      },
    );

  tok
    .command('list')
    .description('List all admin API tokens')
    .action(async () => {
      try {
        const tokens = await getClient().listTokens();
        console.log(formatTokenTable(tokens));
      } catch (err) {
        console.error(`Error: ${toErrorMessage(err)}`);
        process.exit(1);
      }
    });

  tok
    .command('revoke <id>')
    .description('Revoke an admin API token')
    .action(async (id: string) => {
      try {
        await getClient().revokeToken(id);
        console.log(`Token ${id} revoked.`);
      } catch (err) {
        console.error(`Error: ${toErrorMessage(err)}`);
        process.exit(1);
      }
    });
}

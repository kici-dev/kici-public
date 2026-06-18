/**
 * Peer management commands for kici-admin.
 *
 * Provides admin operations for peer token and credential management:
 *   peer create-token   Create a join token for a new peer
 *   peer list           List active peer credentials
 *   peer revoke         Revoke a specific peer's credential
 *   peer revoke-all     Revoke all peer credentials
 */

import type { Command } from 'commander';
import type { AdminApiClient } from '../api-client.js';
import { toErrorMessage, resetRaftStateDirect, prunePeerCredentialsDirect } from '@kici-dev/shared';

import { withDb } from './shared/db.js';
import { JoinTokenManager, silenceJoinTokenLogger } from '../../cluster/join-token.js';
import { PeerCredentialStore } from '../../cluster/peer-credentials.js';

function resolveDirectDbUrl(explicit?: string): string | null {
  return explicit ?? process.env.KICI_DATABASE_URL ?? null;
}

/**
 * Format peer credentials as a table.
 */
function formatPeerTable(
  peers: Array<{
    instanceId: string;
    role: string;
    createdAt: Date;
    lastSeenAt: Date | null;
    expiresAt: Date;
  }>,
): string {
  if (peers.length === 0) return 'No active peers found.';

  const header = 'Instance ID | Role | Created At | Last Seen | Expires At';
  const sep = '-'.repeat(header.length);
  const rows = peers.map((p) => {
    const created = p.createdAt.toISOString();
    const lastSeen = p.lastSeenAt ? p.lastSeenAt.toISOString() : 'never';
    const expires = p.expiresAt.toISOString();
    return `${p.instanceId} | ${p.role} | ${created} | ${lastSeen} | ${expires}`;
  });
  return [header, sep, ...rows].join('\n');
}

export function registerPeerCommands(program: Command, _getClient: () => AdminApiClient): void {
  const peer = program.command('peer').description('Manage peer tokens and credentials');

  peer
    .command('create-token')
    .description('Create a join token for a new peer')
    .option('--role <role>', 'Peer role (worker or coordinator)', 'coordinator')
    .option('--expiry-hours <hours>', 'Token expiry in hours', '1')
    .option('--org-id <id>', 'Organization ID', 'default')
    .option('--routing-key <key>', 'Routing key', 'default')
    .option('--created-by <actor>', 'Attribution written to join_tokens.created_by', 'cli')
    .option('--json', 'Emit JSON { token, role, expiresAt, orgId, routingKey } on stdout', false)
    .action(
      async (opts: {
        role: string;
        expiryHours: string;
        orgId: string;
        routingKey: string;
        createdBy: string;
        json: boolean;
      }) => {
        try {
          const role = opts.role as 'coordinator' | 'worker';
          if (role !== 'coordinator' && role !== 'worker') {
            console.error('Error: --role must be "coordinator" or "worker"');
            process.exit(1);
          }

          const expiryHours = parseFloat(opts.expiryHours);
          if (isNaN(expiryHours) || expiryHours <= 0) {
            console.error('Error: --expiry-hours must be a positive number');
            process.exit(1);
          }

          // In --json mode, stdout is reserved for the structured record.
          // Silence the JoinTokenManager logger so its info line doesn't
          // break downstream JSON parsers.
          if (opts.json) {
            silenceJoinTokenLogger();
          }

          const token = await withDb(async (db) => {
            const tokenManager = new JoinTokenManager({ db });
            return tokenManager.createToken({
              orgId: opts.orgId,
              routingKey: opts.routingKey,
              createdBy: opts.createdBy,
              role,
              expiryMs: expiryHours * 3600_000,
            });
          });

          const expiresAt = new Date(Date.now() + expiryHours * 3600_000);
          if (opts.json) {
            // JSON mode: stdout carries only the structured record so scripts
            // can parse it without tripping on human-readable prose.
            console.log(
              JSON.stringify(
                {
                  token,
                  role,
                  orgId: opts.orgId,
                  routingKey: opts.routingKey,
                  expiresAt: expiresAt.toISOString(),
                },
                null,
                2,
              ),
            );
            return;
          }

          console.log(`Join token created (role: ${role}, expires: ${expiresAt.toISOString()})`);
          console.log('');
          console.log(token);
          console.log('');
          console.log('This token can only be used once. Store it securely.');
        } catch (err) {
          console.error(`Error: ${toErrorMessage(err)}`);
          process.exit(1);
        }
      },
    );

  peer
    .command('list')
    .description('List active peer credentials')
    .action(async () => {
      try {
        const peers = await withDb(async (db) => {
          const store = new PeerCredentialStore(db);
          return store.listActive();
        });

        console.log(formatPeerTable(peers));
      } catch (err) {
        console.error(`Error: ${toErrorMessage(err)}`);
        process.exit(1);
      }
    });

  peer
    .command('revoke')
    .description('Revoke a peer credential by instance ID')
    .requiredOption('--instance-id <id>', 'Instance ID of the peer to revoke')
    .action(async (opts: { instanceId: string }) => {
      try {
        await withDb(async (db) => {
          const store = new PeerCredentialStore(db);
          await store.revoke(opts.instanceId);
        });

        console.log(
          `Peer ${opts.instanceId} credential revoked. It will be disconnected on next heartbeat.`,
        );
      } catch (err) {
        console.error(`Error: ${toErrorMessage(err)}`);
        process.exit(1);
      }
    });

  peer
    .command('revoke-all')
    .description('Revoke all active peer credentials')
    .option('--confirm', 'Confirm revocation of all peer credentials')
    .action(async (opts: { confirm?: boolean }) => {
      if (!opts.confirm) {
        console.error('This will revoke ALL peer credentials. Pass --confirm to proceed.');
        process.exit(1);
      }

      try {
        const count = await withDb(async (db) => {
          const store = new PeerCredentialStore(db);
          return store.revokeAll();
        });

        console.log(`Revoked ${count} peer credentials.`);
      } catch (err) {
        console.error(`Error: ${toErrorMessage(err)}`);
        process.exit(1);
      }
    });

  peer
    .command('prune-credentials')
    .description(
      'DELETE peer_credentials rows whose instance_id does NOT LIKE <filter> (direct-DB only, destructive). Used by cluster e2e to wipe stale staging peer credentials while leaving e2e-* peers intact. HTTP mode is intentionally unsupported: the call site is a warm-deploy preflight run while the orchestrator is stopped, mirroring peer reset-raft-state.',
    )
    .requiredOption(
      '--filter <pattern>',
      'SQL LIKE pattern for instance_ids to KEEP (e.g. "e2e-%"). Rows that do NOT match are deleted.',
    )
    .option('--database-url <url>', 'Use direct DB access (offline mode, required)')
    .option('--json', 'Emit JSON { deleted } on stdout', false)
    .action(async (opts: { filter: string; databaseUrl?: string; json?: boolean }) => {
      try {
        const dbUrl = resolveDirectDbUrl(opts.databaseUrl);
        if (!dbUrl) {
          console.error(
            'Error: prune-credentials requires --database-url (or KICI_DATABASE_URL). ' +
              'This verb is intentionally direct-DB only because its call site is a ' +
              'warm-deploy preflight run while the orchestrator is stopped, mirroring ' +
              'peer reset-raft-state.',
          );
          process.exit(1);
        }
        const result = await prunePeerCredentialsDirect(dbUrl, {
          keepInstanceIdPattern: opts.filter,
        });
        if (opts.json) {
          console.log(JSON.stringify(result));
        } else {
          console.log(`peer credentials pruned: ${result.deleted} rows deleted`);
        }
      } catch (err) {
        console.error(`Error: ${toErrorMessage(err)}`);
        process.exit(1);
      }
    });

  peer
    .command('reset-raft-state')
    .description(
      'DELETE all rows from raft_state so a freshly-started orchestrator self-elects with a clean term (direct-DB only, destructive)',
    )
    .option('--database-url <url>', 'Use direct DB access (offline mode, required)')
    .option('--json', 'Emit JSON { rowsDeleted } on stdout', false)
    .action(async (opts: { databaseUrl?: string; json?: boolean }) => {
      try {
        const dbUrl = resolveDirectDbUrl(opts.databaseUrl);
        if (!dbUrl) {
          console.error(
            'Error: reset-raft-state requires --database-url (or KICI_DATABASE_URL). ' +
              'This verb is intentionally direct-DB only because its call site is a ' +
              'warm-deploy preflight run while the orchestrator is stopped.',
          );
          process.exit(1);
        }

        const result = await resetRaftStateDirect(dbUrl);
        if (opts.json) {
          console.log(JSON.stringify(result));
        } else {
          console.log(`raft_state reset: ${result.rowsDeleted} rows deleted`);
        }
      } catch (err) {
        console.error(`Error: ${toErrorMessage(err)}`);
        process.exit(1);
      }
    });
}

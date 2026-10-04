/**
 * Peer management commands for kici-admin.
 *
 * Provides admin operations for peer token and credential management:
 *   peer create-token   Create a join token for a new peer
 *   peer list           List active peer credentials
 *   peer revoke         Revoke a specific peer's credential
 *   peer forget         Drop a departed peer from every coordinator's live
 *                       peer registry (admin HTTP API; credential untouched)
 *   peer revoke-all     Revoke all peer credentials
 */

import type { Command } from 'commander';
import type { AdminApiClient, PeerForgetResponseBody } from '../api-client.js';
import { confirmPrompt } from './shared/confirm.js';
import { toErrorMessage, resetRaftStateDirect, prunePeerCredentialsDirect } from '@kici-dev/shared';
import { PeerForgetOutcome } from '@kici-dev/engine';

import { withDb } from './shared/db.js';
import { JoinTokenManager, silenceJoinTokenLogger } from '../../cluster/join-token.js';
import {
  PeerCredentialIssuance,
  PeerCredentialStore,
  type PeerCredential,
} from '../../cluster/peer-credentials.js';

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

/**
 * The `peer list --json` record. The credential hash is the HMAC key of every
 * proof, so it, the source-token hash and the raw metadata never leave the
 * database.
 */
function toPeerListEntry(p: PeerCredential) {
  return {
    id: p.id,
    instanceId: p.instanceId,
    role: p.role,
    selfIssued: p.metadata?.issuance === PeerCredentialIssuance.Self,
    createdAt: p.createdAt.toISOString(),
    lastSeenAt: p.lastSeenAt ? p.lastSeenAt.toISOString() : null,
    lastValidatedBy: p.lastValidatedBy,
    expiresAt: p.expiresAt.toISOString(),
  };
}

/** Where `peer forget` writes its results. */
export interface PeerForgetIo {
  out: (line: string) => void;
  /** Asks the operator; resolves true on yes. */
  confirm: (prompt: string) => Promise<boolean>;
  /** Whether an operator can answer a prompt (stdin is a terminal). */
  interactive: boolean;
}

/** The backstop consequence a coordinator named, when one needs acknowledging. */
function backstopConsequenceOf(body: PeerForgetResponseBody): string | null {
  if (body.acknowledgementRequired)
    return body.error ?? 'forgetting this peer switches the event-provision backstop back on';
  const sibling = body.results.find(
    (r) => r.outcome === PeerForgetOutcome.enum['acknowledgement-required'],
  );
  return sibling ? `${sibling.coordinator}: ${sibling.detail}` : null;
}

function printForgetResults(body: PeerForgetResponseBody, json: boolean, io: PeerForgetIo): void {
  if (json) {
    io.out(JSON.stringify(body, null, 2));
    return;
  }
  for (const result of body.results) {
    io.out(`${result.coordinator}: ${result.outcome} — ${result.detail}`);
  }
}

/**
 * `kici-admin peer forget`: drop a departed peer from this coordinator's live
 * peer registry and every connected sibling's. Exits 1 when any coordinator
 * kept it (connected, heard from recently, or no answer).
 *
 * When the forget would switch a coordinator's event-provision backstop back
 * on, the operator confirms that consequence first; `--yes` acknowledges it up
 * front, and without a terminal the command refuses instead of asking.
 *
 * @returns the process exit code
 */
export async function runPeerForget(
  client: Pick<AdminApiClient, 'forgetPeer'>,
  instanceId: string,
  opts: { json: boolean; timeout: string; yes: boolean },
  io: PeerForgetIo,
): Promise<number> {
  const seconds = Number(opts.timeout);
  if (!Number.isInteger(seconds) || seconds < 1 || seconds > 60) {
    throw new Error(
      `--timeout must be a whole number of seconds from 1 to 60, got "${opts.timeout}"`,
    );
  }
  const timeoutMs = seconds * 1_000;
  let body = await client.forgetPeer({
    instanceId,
    timeoutMs,
    ...(opts.yes ? { acknowledgeBackstop: true } : {}),
  });
  const consequence = opts.yes ? null : backstopConsequenceOf(body);
  if (consequence) {
    if (!io.interactive) {
      throw new Error(`${consequence} Pass --yes to forget ${instanceId} anyway.`);
    }
    if (!(await io.confirm(`${consequence}\nForget ${instanceId} anyway? [y/N] `))) {
      printForgetResults(body, opts.json, io);
      // Declined before anything changed: the coordinator kept the peer.
      return body.acknowledgementRequired ? 0 : 1;
    }
    body = await client.forgetPeer({ instanceId, timeoutMs, acknowledgeBackstop: true });
  }
  printForgetResults(body, opts.json, io);
  const kept = body.results.some(
    (r) =>
      r.outcome !== PeerForgetOutcome.enum.forgotten &&
      r.outcome !== PeerForgetOutcome.enum['not-found'],
  );
  return kept ? 1 : 0;
}

export function registerPeerCommands(program: Command, getClient: () => AdminApiClient): void {
  const peer = program.command('peer').description('Manage peer tokens and credentials');

  peer
    .command('forget <instance-id>')
    .description(
      'Drop a peer that left the cluster from the live peer registry of every coordinator (its credential is untouched)',
    )
    .option('--timeout <seconds>', 'How long to wait for each sibling coordinator', '15')
    .option(
      '--yes',
      'Forget the peer even when that switches the event-provision backstop back on, without asking',
      false,
    )
    .option('--json', 'Emit machine-readable JSON', false)
    .action(async (instanceId: string, opts: { json: boolean; timeout: string; yes: boolean }) => {
      try {
        process.exitCode = await runPeerForget(getClient(), instanceId, opts, {
          out: (line) => console.log(line),
          confirm: (prompt) => confirmPrompt(prompt),
          interactive: process.stdin.isTTY === true,
        });
      } catch (err) {
        console.error(`Error: ${toErrorMessage(err)}`);
        process.exit(1);
      }
    });

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
          console.log('This token works until it expires. Treat it like a password.');
        } catch (err) {
          console.error(`Error: ${toErrorMessage(err)}`);
          process.exit(1);
        }
      },
    );

  peer
    .command('list')
    .description('List active peer credentials')
    .option(
      '--json',
      'Emit JSON { peers: [{ id, instanceId, role, selfIssued, createdAt, lastSeenAt, lastValidatedBy, expiresAt }] } on stdout',
      false,
    )
    .action(async (opts: { json: boolean }) => {
      try {
        const peers = await withDb(async (db) => {
          const store = new PeerCredentialStore(db);
          return store.listActive();
        });

        if (opts.json) {
          console.log(JSON.stringify({ peers: peers.map(toPeerListEntry) }, null, 2));
          return;
        }
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
          `Peer ${opts.instanceId} credential revoked. Its next connection attempt is refused; its open connections stay up.`,
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
      'DELETE peer_credentials rows whose instance_id does NOT LIKE <filter> (direct-DB only, destructive). Intended as a warm-deploy preflight to wipe stale peer credentials while keeping selected peers. HTTP mode is intentionally unsupported: the call site runs while the orchestrator is stopped, mirroring peer reset-raft-state.',
    )
    .requiredOption(
      '--filter <pattern>',
      'SQL LIKE pattern for instance_ids to KEEP (e.g. "keep-%"). Rows that do NOT match are deleted.',
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

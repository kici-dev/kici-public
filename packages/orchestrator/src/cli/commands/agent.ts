/**
 * Agent token management commands for kici-admin.
 *
 * Provides CRUD operations for agent authentication tokens:
 *   agent register, list, revoke
 */

import type { Command } from 'commander';
import type { AdminApiClient } from '../api-client.js';
import { toErrorMessage } from '@kici-dev/shared';
import { PRIVILEGED_ROOT_LABEL } from '@kici-dev/engine';

/**
 * Format agent tokens as a table.
 */
function formatAgentTokenTable(tokens: any[]): string {
  if (tokens.length === 0) return 'No agent tokens found.';

  const header = 'ID | Prefix | Labels | Type | Created | Last Seen | Expires';
  const sep = '-'.repeat(header.length);
  const rows = tokens.map((t: any) => {
    const id = t.id ?? '-';
    const prefix = t.tokenPrefix ?? '-';
    const labels = Array.isArray(t.labels) ? t.labels.join(',') : '-';
    const type = t.agentType ?? '-';
    const created = t.createdAt ?? '-';
    const lastSeen = t.lastSeenAt ?? '-';
    const expires = t.expiresAt ?? 'never';
    return `${id} | ${prefix} | ${labels} | ${type} | ${created} | ${lastSeen} | ${expires}`;
  });
  return [header, sep, ...rows].join('\n');
}

export function registerAgentCommands(program: Command, getClient: () => AdminApiClient): void {
  const agent = program.command('agent').description('Manage agent authentication tokens');

  agent
    .command('register')
    .description('Create a static agent token')
    .option('--labels <labels>', 'Comma-separated agent labels (e.g. linux,x64)')
    .option(
      '--mandatory-label <label>',
      'Taint label the agent only accepts jobs demanding (repeatable). Also authorized as an advertised label.',
      (val: string, acc: string[]) => [...acc, val.trim()],
      [] as string[],
    )
    .option(
      '--privileged-root',
      `Shorthand for --mandatory-label ${PRIVILEGED_ROOT_LABEL}: mint a confined root agent token (the agent must run as uid 0).`,
    )
    .action(
      async (opts: { labels?: string; mandatoryLabel: string[]; privilegedRoot?: boolean }) => {
        try {
          const mandatorySet = new Set<string>(opts.mandatoryLabel);
          if (opts.privilegedRoot) mandatorySet.add(PRIVILEGED_ROOT_LABEL);
          const mandatoryLabels = mandatorySet.size > 0 ? [...mandatorySet] : undefined;

          const baseLabels = opts.labels ? opts.labels.split(',').map((l) => l.trim()) : [];
          // A mandatory (taint) label must also be advertisable (the selector side),
          // so union it into the authorized labels — a taint the agent can't even
          // advertise would be incoherent.
          const labelSet = new Set<string>([...baseLabels, ...(mandatoryLabels ?? [])]);
          const labels = labelSet.size > 0 ? [...labelSet] : undefined;

          const result = await getClient().createAgentToken({ labels, mandatoryLabels });
          console.log(`Agent token created successfully.`);
          console.log(`Token ID: ${result.id}`);
          console.log(`Token:    ${result.token}`);
          if (mandatoryLabels) {
            console.log(
              `Taint:    ${mandatoryLabels.join(', ')} (agent only accepts jobs demanding these)`,
            );
          }
          console.log('');
          console.log('WARNING: Save this token now -- it cannot be recovered after this point.');
          console.log('Set KICI_AGENT_TOKEN on the agent to use this token.');
        } catch (err) {
          console.error(`Error: ${toErrorMessage(err)}`);
          process.exit(1);
        }
      },
    );

  agent
    .command('list')
    .description('List agent tokens')
    .option('--type <type>', 'Filter by type: static or ephemeral')
    .option(
      '--include-pending',
      'Include agents that have connected via WS but have not completed registration (HTTP mode only; direct-DB cannot see in-memory state)',
    )
    .option('--database-url <url>', 'Use direct DB access instead of HTTP (offline mode)')
    .option('--json', 'Emit JSON output')
    .action(
      async (opts: {
        type?: string;
        includePending?: boolean;
        databaseUrl?: string;
        json?: boolean;
      }) => {
        try {
          const dbUrl = opts.databaseUrl ?? process.env.KICI_DATABASE_URL;
          if (dbUrl && opts.includePending) {
            console.error(
              'warning: --include-pending is ignored in direct-DB mode (pending state is in-memory on the orchestrator).',
            );
          }
          if (dbUrl) {
            // Read agent_tokens directly — pending agents are orchestrator
            // in-memory state and cannot be surfaced offline.
            const { createPool } = await import('@kici-dev/shared');
            const pool = createPool(dbUrl);
            try {
              const clauses: string[] = ['revoked_at IS NULL'];
              const params: unknown[] = [];
              if (opts.type) {
                clauses.push(`agent_type = $${params.length + 1}`);
                params.push(opts.type);
              }
              const result = await pool.query(
                `SELECT id, token_prefix, labels, agent_type, created_at,
                        last_seen_at, expires_at
                   FROM agent_tokens
                  WHERE ${clauses.join(' AND ')}
                  ORDER BY created_at DESC`,
                params,
              );
              const tokens = result.rows.map((t: any) => ({
                id: t.id,
                tokenPrefix: t.token_prefix,
                labels: typeof t.labels === 'string' ? JSON.parse(t.labels) : (t.labels ?? []),
                agentType: t.agent_type,
                createdAt: t.created_at,
                lastSeenAt: t.last_seen_at,
                expiresAt: t.expires_at,
                pending: false,
              }));
              if (opts.json) {
                console.log(JSON.stringify({ tokens, pendingAgents: [] }));
              } else {
                console.log(formatAgentTokenTable(tokens));
              }
            } finally {
              await pool.end();
            }
            return;
          }

          const result = await getClient().listAgentTokens(
            opts.type ? { type: opts.type } : undefined,
          );
          // When --include-pending is set, hit the pending endpoint too.
          let pendingAgents: any[] = [];
          if (opts.includePending) {
            try {
              pendingAgents = await getClient().get<any[]>('/api/v1/agent-tokens/pending');
            } catch (err) {
              // If the route is not yet deployed on this orchestrator, emit
              // a warning rather than failing the whole command.
              console.error(
                `warning: --include-pending failed (${toErrorMessage(err)}); continuing without pending list.`,
              );
            }
          }
          if (opts.json) {
            console.log(JSON.stringify({ tokens: result.tokens, pendingAgents }));
          } else {
            console.log(formatAgentTokenTable(result.tokens));
            if (pendingAgents.length > 0) {
              console.log('');
              console.log(`Pending agents (${pendingAgents.length}):`);
              for (const p of pendingAgents) {
                console.log(`  ${JSON.stringify(p)}`);
              }
            }
          }
        } catch (err) {
          console.error(`Error: ${toErrorMessage(err)}`);
          process.exit(1);
        }
      },
    );

  agent
    .command('revoke <id>')
    .description('Revoke an agent token by ID')
    .action(async (id: string) => {
      try {
        const { kicked } = await getClient().revokeAgentToken(id);
        //: surface the kick count so the operator knows the
        // revocation actually closed in-flight WS — a 0 count on a
        // token they expected to be live is a useful diagnostic
        // (token never connected, or already disconnected on its own).
        const noun = kicked === 1 ? 'connection' : 'connections';
        console.log(`Agent token ${id} revoked (kicked ${kicked} agent ${noun}).`);
      } catch (err) {
        console.error(`Error: ${toErrorMessage(err)}`);
        process.exit(1);
      }
    });
}

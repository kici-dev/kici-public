/** `kici-admin agent register|list|revoke`: agent token management. */

import type { Command } from 'commander';
import type { AdminApiClient } from '../api-client.js';
import { toErrorMessage } from '@kici-dev/shared';
import { PRIVILEGED_ROOT_LABEL, resolveRoleLabels } from '@kici-dev/engine';
import { cliAction, DIRECT_DB_URL_FLAG, DIRECT_DB_URL_HELP } from './shared/cli-action.js';

/**
 * The authorized label scope a static agent token is minted with: the
 * operator's `--labels`, plus
 *
 * - each mandatory (taint) label, which must also be advertisable;
 * - the whole `kici:role:*` namespace. An agent derives its roles from its own
 *   host and advertises them at registration, so a scope without them fails the
 *   register-time gate (`Agent labels exceed token-bound scope`); the mint site
 *   cannot know which roles the host will derive.
 *
 * The operator's labels still bound everything else: `--labels linux,x64`
 * refuses an agent advertising `gpu`. An agent with no roles sets `KICI_ROLES=`.
 *
 * Undefined with no labels and no taint: an unscoped token, which the
 * register-time gate skips.
 */
export function authorizedAgentTokenLabels(
  baseLabels: readonly string[],
  mandatoryLabels: readonly string[] | undefined,
): string[] | undefined {
  const operatorLabels = [...baseLabels, ...(mandatoryLabels ?? [])];
  if (operatorLabels.length === 0) return undefined;
  return [...new Set([...operatorLabels, ...resolveRoleLabels(undefined)])];
}

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
    .option(
      '--labels <labels>',
      'Comma-separated agent labels (e.g. linux,x64). The kici:role:* namespace is authorized implicitly.',
    )
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
      cliAction(
        async (opts: { labels?: string; mandatoryLabel: string[]; privilegedRoot?: boolean }) => {
          const mandatorySet = new Set<string>(opts.mandatoryLabel);
          if (opts.privilegedRoot) mandatorySet.add(PRIVILEGED_ROOT_LABEL);
          const mandatoryLabels = mandatorySet.size > 0 ? [...mandatorySet] : undefined;

          const baseLabels = opts.labels ? opts.labels.split(',').map((l) => l.trim()) : [];
          const labels = authorizedAgentTokenLabels(baseLabels, mandatoryLabels);

          const result = await getClient().createAgentToken({ labels, mandatoryLabels });
          console.log(`Agent token created successfully.`);
          console.log(`Token ID: ${result.id}`);
          console.log(`Token:    ${result.token}`);
          if (labels) {
            console.log(`Labels:   ${labels.join(', ')} (agent role labels authorized implicitly)`);
          }
          if (mandatoryLabels) {
            console.log(
              `Taint:    ${mandatoryLabels.join(', ')} (agent only accepts jobs demanding these)`,
            );
          }
          console.log('');
          console.log('WARNING: Save this token now -- it cannot be recovered after this point.');
          console.log('Set KICI_AGENT_TOKEN on the agent to use this token.');
        },
      ),
    );

  agent
    .command('list')
    .description('List agent tokens')
    .option('--type <type>', 'Filter by type: static or ephemeral')
    .option(
      '--include-pending',
      'Include agents that have connected via WS but have not completed registration (HTTP mode only; direct-DB cannot see in-memory state)',
    )
    .option(DIRECT_DB_URL_FLAG, DIRECT_DB_URL_HELP)
    .option('--json', 'Emit JSON output')
    .action(
      cliAction(
        async (opts: {
          type?: string;
          includePending?: boolean;
          databaseUrl?: string;
          json?: boolean;
        }) => {
          const dbUrl = opts.databaseUrl ?? process.env.KICI_DATABASE_URL;
          if (dbUrl && opts.includePending) {
            console.error(
              'warning: --include-pending is ignored in direct-DB mode (pending state is in-memory on the orchestrator).',
            );
          }
          if (dbUrl) {
            // Pending agents live in orchestrator memory, so offline reads show none.
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
          let pendingAgents: any[] = [];
          if (opts.includePending) {
            try {
              pendingAgents = await getClient().get<any[]>('/api/v1/agent-tokens/pending');
            } catch (err) {
              // An orchestrator without the route warns, not fails.
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
        },
      ),
    );

  agent
    .command('revoke <id>')
    .description('Revoke an agent token by ID')
    .action(
      cliAction(async (id: string) => {
        const { kicked } = await getClient().revokeAgentToken(id);
        // The kick count confirms in-flight WS closed; 0 on an expected-live
        // token means it never connected or already disconnected.
        const noun = kicked === 1 ? 'connection' : 'connections';
        console.log(`Agent token ${id} revoked (kicked ${kicked} agent ${noun}).`);
      }),
    );
}

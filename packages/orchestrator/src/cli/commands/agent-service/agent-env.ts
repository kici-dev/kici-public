/**
 * The env file `kici-admin agent install` writes. The agent's config loader
 * refuses unknown KICI_* variables, so a misspelt key stops the agent at
 * startup; `agent-env.test.ts` loads the output through that loader.
 */

export interface AgentEnvFields {
  /** First line of the file, a `#` comment naming what wrote it. */
  header: string;
  orchestratorUrl?: string;
  token?: string;
  /** Routing labels, written comma-separated. */
  labels?: string[];
  /** The agent's HTTP port; omitted, the agent uses its default. */
  port?: number;
}

export function renderAgentEnvFile(fields: AgentEnvFields): string {
  const lines = [fields.header];
  if (fields.orchestratorUrl) lines.push(`KICI_ORCHESTRATOR_URL=${fields.orchestratorUrl}`);
  if (fields.token) lines.push(`KICI_AGENT_TOKEN=${fields.token}`);
  if (fields.labels && fields.labels.length > 0) {
    lines.push(`KICI_LABELS=${fields.labels.join(',')}`);
  }
  if (fields.port !== undefined) lines.push(`KICI_PORT=${fields.port}`);
  return `${lines.join('\n')}\n`;
}

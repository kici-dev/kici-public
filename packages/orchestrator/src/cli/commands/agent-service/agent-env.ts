/**
 * The env file `kici-admin agent install` writes for a new agent. Each field
 * lands in the variable the agent's config loader reads; that loader refuses
 * any KICI_* variable it does not know, so a misspelt key here stops the agent
 * at startup. `agent-env.test.ts` loads the rendered file through the agent's
 * own loader to hold the two together.
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

/** Render the env file, one `KEY=value` line per field that was given. */
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

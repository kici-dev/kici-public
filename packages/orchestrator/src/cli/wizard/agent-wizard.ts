/**
 * Interactive agent setup: the install command writes the env file from the
 * result.
 */

import { promptUrl, promptSecret } from './prompts.js';
import { input } from '@inquirer/prompts';

interface AgentInstallConfig {
  orchestratorUrl: string;
  agentToken: string;
  labels: string[];
}

/** Asks only for the orchestrator URL, the agent token and optional comma-separated labels. */
export async function runAgentWizard(): Promise<AgentInstallConfig> {
  console.log('');
  console.log('KiCI agent setup wizard');
  console.log('=======================');
  console.log('');

  const orchestratorUrl = await promptUrl('Orchestrator URL:', 'http://localhost:4000');

  console.log('');
  const agentToken = await promptSecret('Agent authentication token:');

  console.log('');
  const labelsInput = await input({
    message: 'Agent labels (comma-separated; empty = only the kici:* labels every agent reports):',
    default: '',
  });
  const labels = labelsInput
    .split(',')
    .map((l) => l.trim())
    .filter(Boolean);

  console.log('');
  console.log('Configuration complete. Summary:');
  console.log(`  Orchestrator: ${orchestratorUrl}`);
  console.log(
    `  Labels:       ${labels.length > 0 ? labels.join(', ') : '(none; only the kici:* labels every agent reports)'}`,
  );
  console.log('');

  return {
    orchestratorUrl,
    agentToken,
    labels,
  };
}

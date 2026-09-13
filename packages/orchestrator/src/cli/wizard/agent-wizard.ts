/**
 * Interactive wizard for agent service setup.
 *
 * Walks the user through essential agent configuration
 * (orchestrator URL, token, labels). Returns a config object
 * that the install command uses to write the env file.
 */

import { promptUrl, promptSecret } from './prompts.js';
import { input } from '@inquirer/prompts';

/** Config produced by the agent wizard. */
interface AgentInstallConfig {
  orchestratorUrl: string;
  agentToken: string;
  labels: string[];
}

/**
 * Run the interactive agent setup wizard.
 *
 * Asks only essential questions:
 * 1. Orchestrator URL
 * 2. Agent authentication token
 * 3. Labels (optional, comma-separated)
 */
export async function runAgentWizard(): Promise<AgentInstallConfig> {
  console.log('');
  console.log('KiCI agent setup wizard');
  console.log('=======================');
  console.log('');

  // 1. Orchestrator URL
  const orchestratorUrl = await promptUrl('Orchestrator URL:', 'http://localhost:4000');

  // 2. Agent token
  console.log('');
  const agentToken = await promptSecret('Agent authentication token:');

  // 3. Labels
  console.log('');
  const labelsInput = await input({
    message: 'Agent labels (comma-separated, empty = accept all jobs):',
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
    `  Labels:       ${labels.length > 0 ? labels.join(', ') : '(none - accepts all jobs)'}`,
  );
  console.log('');

  return {
    orchestratorUrl,
    agentToken,
    labels,
  };
}

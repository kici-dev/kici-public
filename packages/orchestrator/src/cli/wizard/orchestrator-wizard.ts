/**
 * Interactive wizard for orchestrator service setup.
 *
 * Walks the user through essential configuration (mode, DB URL,
 * port, secrets key) with sensible defaults. Returns a config
 * object that the install command uses to write the env file.
 */

import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import {
  promptDbUrl,
  promptPort,
  promptConfirm,
  promptUrl,
  promptSecret,
  promptSelect,
} from './prompts.js';
import { input } from '@inquirer/prompts';

/** Config produced by the orchestrator wizard. */
interface OrchestratorInstallConfig {
  mode: 'platform' | 'hybrid' | 'independent';
  databaseUrl: string;
  port: number;
  secretsKey: string;
  bootstrapAdminToken: string;
  platformUrl?: string;
  platformToken?: string;
  /** Source to add after orchestrator is running. */
  source?: {
    provider: string;
    name: string;
    appId: string;
    privateKey: string;
    webhookSecret?: string;
  };
}

/**
 * Run the interactive orchestrator setup wizard.
 *
 * Asks only essential questions per the user decision:
 * 1. Mode (platform/hybrid/independent)
 * 2. Database URL
 * 3. Port
 * 4. Secrets encryption key
 * 5. Bootstrap admin token (for kici-admin authentication)
 * 6. Platform URL + token (if platform/hybrid mode)
 * 7. Webhook secret (if hybrid/independent mode)
 */
export async function runOrchestratorWizard(): Promise<OrchestratorInstallConfig> {
  console.log('');
  console.log('KiCI orchestrator setup wizard');
  console.log('==============================');
  console.log('');

  // 1. Mode
  const mode = await promptSelect<'platform' | 'hybrid' | 'independent'>(
    'Operating mode:',
    [
      {
        name: 'Platform relay (recommended)',
        value: 'platform',
        description: 'Connect to KiCI Platform for webhook routing',
      },
      { name: 'Hybrid', value: 'hybrid', description: 'Platform relay + direct webhooks' },
      {
        name: 'Independent',
        value: 'independent',
        description: 'Self-hosted, no Platform dependency',
      },
    ],
    'platform',
  );

  // 2. Database URL
  console.log('');
  const databaseUrl = await promptDbUrl();

  // 3. Port
  const port = await promptPort(4000);

  // 4. Secrets encryption key
  console.log('');
  const generatedKey = randomBytes(32).toString('hex');
  console.log(`Generated secrets key: ${generatedKey}`);
  const useGenerated = await promptConfirm('Use this key?');
  let secretsKey: string;
  if (useGenerated) {
    secretsKey = generatedKey;
  } else {
    secretsKey = await promptSecret('Enter custom secrets encryption key (64 hex chars):');
  }

  // 5. Bootstrap admin token (used by `kici-admin` to authenticate against
  //    this orchestrator — e.g. `kici-admin source add`)
  console.log('');
  const generatedAdminToken = randomBytes(32).toString('hex');
  console.log(`Generated bootstrap admin token: ${generatedAdminToken}`);
  const useGeneratedAdminToken = await promptConfirm('Use this token?');
  let bootstrapAdminToken: string;
  if (useGeneratedAdminToken) {
    bootstrapAdminToken = generatedAdminToken;
  } else {
    bootstrapAdminToken = await promptSecret('Enter custom bootstrap admin token:');
  }

  // 6. Platform connection (platform/hybrid modes)
  let platformUrl: string | undefined;
  let platformToken: string | undefined;
  if (mode === 'platform' || mode === 'hybrid') {
    console.log('');
    platformUrl = await promptUrl('Platform relay URL:', 'wss://platform.kici.dev');
    platformToken = await promptSecret('Platform authentication token:');
  }

  // 7. Source setup (optional)
  let source: OrchestratorInstallConfig['source'];
  console.log('');
  const addSource = await promptConfirm('Add a GitHub App source?', false);
  if (addSource) {
    const sourceName = await input({ message: 'Source name (e.g. main-org):' });
    const appId = await input({
      message: 'GitHub App ID:',
      validate: (v: string) => (/^\d+$/.test(v.trim()) ? true : 'Must be a numeric App ID'),
    });
    const privateKeyPath = await input({
      message: 'Path to private key file (.pem):',
      validate: (v: string) => (v.trim() ? true : 'Path is required'),
    });
    const sourceWebhookSecret = await promptSecret('Webhook secret:');

    let privateKey: string;
    try {
      privateKey = (await readFile(privateKeyPath.trim(), 'utf-8')).trim();
    } catch (err) {
      throw new Error(`Failed to read private key from ${privateKeyPath}: ${err}`);
    }

    source = {
      provider: 'github',
      name: sourceName.trim(),
      appId: appId.trim(),
      privateKey,
      webhookSecret: sourceWebhookSecret,
    };
  }

  console.log('');
  console.log('Configuration complete. Summary:');
  console.log(`  Mode:     ${mode}`);
  console.log(`  Database: ${databaseUrl.replace(/:[^@]*@/, ':***@')}`);
  console.log(`  Port:     ${port}`);
  console.log(`  Admin token: ${bootstrapAdminToken.slice(0, 8)}…`);
  console.log(`  Platform:     ${platformUrl ?? 'N/A'}`);
  if (source) {
    console.log(`  Source:   ${source.provider}:${source.appId} (${source.name})`);
  }
  console.log('');

  return {
    mode,
    databaseUrl,
    port,
    secretsKey,
    bootstrapAdminToken,
    platformUrl,
    platformToken,
    source,
  };
}

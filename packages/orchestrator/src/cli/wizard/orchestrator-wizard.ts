/**
 * Interactive wizard for orchestrator service setup.
 *
 * Walks the user through essential configuration (mode, DB URL,
 * port, secrets key) with sensible defaults. Returns a config
 * object that the install command uses to write the env file.
 */

import { randomBytes } from 'node:crypto';
import { access } from 'node:fs/promises';
import { constants } from 'node:fs';
import {
  promptDbUrl,
  promptPort,
  promptConfirm,
  promptUrl,
  promptSecret,
  promptSelect,
} from './prompts.js';
import { OrchestratorMode, PLATFORM_CONNECTED_MODES } from '@kici-dev/engine';
import { input } from '@inquirer/prompts';

/** A GitHub App source the wizard collected, to be added once the orchestrator is running. */
export interface OrchestratorSourceHint {
  name: string;
  appId: string;
  /** Filesystem path to the App private key (.pem) — NOT the key contents. */
  privateKeyPath: string;
  webhookSecret?: string;
}

/** Config produced by the orchestrator wizard. */
interface OrchestratorInstallConfig {
  mode: OrchestratorMode;
  databaseUrl: string;
  port: number;
  secretsKey: string;
  bootstrapAdminToken: string;
  platformUrl?: string;
  platformToken?: string;
  /** Public base URL of this orchestrator's own ingress (required in observed mode). */
  webhookPublicUrl?: string;
  /** GitHub App source to add after the orchestrator is running. */
  source?: OrchestratorSourceHint;
}

/** POSIX single-quote a value so it is safe to paste into a shell command. */
function shq(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * Render the post-install next-step lines for adding the collected GitHub App
 * source. The primary command inlines the webhook secret (copy-paste-runnable);
 * when a secret is present a "Secure alternative" pipes it via stdin so the
 * secret stays out of the process argument list (printf is a shell builtin, and
 * kici-admin receives the value on stdin — so it never appears in `ps`). Returns
 * indented lines for the install "Next steps" block.
 */
export function formatSourceAddHint(hint: OrchestratorSourceHint): string[] {
  const key = shq(`@${hint.privateKeyPath}`);
  const secretFlag = hint.webhookSecret ? ` --webhook-secret ${shq(hint.webhookSecret)}` : '';
  const lines = [
    `       kici-admin source add github --name ${shq(hint.name)} --app-id ${hint.appId} \\`,
    `         --private-key ${key}${secretFlag}`,
  ];
  if (hint.webhookSecret) {
    lines.push(
      '     Secure alternative (keeps the secret out of the process argument list):',
      `       printf %s ${shq(hint.webhookSecret)} | kici-admin source add github --name ${shq(hint.name)} --app-id ${hint.appId} \\`,
      `         --private-key ${key} --webhook-secret -`,
    );
  }
  return lines;
}

/**
 * Check that the private-key path the operator gave is readable. Returns a
 * warning string when it is not, so the wizard can surface it without aborting
 * the whole install — the source is opt-in and secondary to the orchestrator.
 */
export async function checkPrivateKeyReadable(keyPath: string): Promise<string | null> {
  try {
    await access(keyPath, constants.R_OK);
    return null;
  } catch {
    return `Warning: private key path ${keyPath} is not readable — fix the path before running the source-add command`;
  }
}

/**
 * Default Platform relay URL offered by the install wizard. Kept in lockstep
 * with the quickstart compose `KICI_PLATFORM_URL` value (`wss://api.kici.dev/ws`)
 * — the single hosted KiCI Platform relay endpoint. Pinned by
 * orchestrator-wizard.test.ts so the two surfaces cannot drift.
 */
export const DEFAULT_PLATFORM_RELAY_URL = 'wss://api.kici.dev/ws';

/**
 * Run the interactive orchestrator setup wizard.
 *
 * Asks only essential questions per the user decision:
 * 1. Mode (platform/hybrid/observed/independent)
 * 2. Database URL
 * 3. Port
 * 4. Secrets encryption key
 * 5. Bootstrap admin token (for kici-admin authentication)
 * 6. Platform URL + token (if platform/hybrid/observed mode), plus the public
 *    webhook base URL when observed
 * 7. Webhook secret (if hybrid/independent mode)
 */
export async function runOrchestratorWizard(): Promise<OrchestratorInstallConfig> {
  console.log('');
  console.log('KiCI orchestrator setup wizard');
  console.log('==============================');
  console.log('');

  // 1. Mode
  const mode = await promptSelect<OrchestratorMode>(
    'Operating mode:',
    [
      {
        name: 'Platform relay (recommended)',
        value: 'platform',
        description: 'Connect to KiCI Platform for webhook routing',
      },
      { name: 'Hybrid', value: 'hybrid', description: 'Platform relay + direct webhooks' },
      {
        name: 'Observed',
        value: 'observed',
        description: 'Direct webhooks only (nothing transits KiCI) + hosted dashboard',
      },
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

  // 6. Platform connection (platform/hybrid/observed modes)
  let platformUrl: string | undefined;
  let platformToken: string | undefined;
  let webhookPublicUrl: string | undefined;
  if (PLATFORM_CONNECTED_MODES.includes(mode)) {
    console.log('');
    platformUrl = await promptUrl('Platform relay URL:', DEFAULT_PLATFORM_RELAY_URL);
    platformToken = await promptSecret('Platform authentication token:');
  }
  if (mode === OrchestratorMode.enum.observed) {
    console.log('');
    webhookPublicUrl = await promptUrl(
      "This orchestrator's public webhook base URL:",
      'https://kici.example.com',
    );
  }

  // 7. Source setup (optional). Observed mode refuses GitHub-App sources —
  // they are ingested through the Platform relay, which observed never accepts.
  let source: OrchestratorInstallConfig['source'];
  const canAddGithubSource = mode !== OrchestratorMode.enum.observed;
  console.log('');
  const addSource = canAddGithubSource
    ? await promptConfirm('Add a GitHub App source?', false)
    : false;
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

    const warning = await checkPrivateKeyReadable(privateKeyPath.trim());
    if (warning) console.warn(warning);

    source = {
      name: sourceName.trim(),
      appId: appId.trim(),
      privateKeyPath: privateKeyPath.trim(),
      webhookSecret: sourceWebhookSecret || undefined,
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
    console.log(`  Source:   github:${source.appId} (${source.name})`);
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
    webhookPublicUrl,
    source,
  };
}

/** Interactive orchestrator setup wizard; install writes its result to the env file. */

import { randomBytes } from 'node:crypto';
import { access } from 'node:fs/promises';
import { constants } from 'node:fs';
import {
  promptDbUrl,
  promptPort,
  promptConfirm,
  promptUrl,
  promptOptionalUrl,
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

export interface OrchestratorWizardOptions {
  /**
   * Preselected mode (`orchestrator install --mode`). Defaults to `hybrid`:
   * the Platform relay plus this orchestrator's own direct webhook ingress.
   */
  defaultMode?: OrchestratorMode;
}

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
  source?: OrchestratorSourceHint;
}

/** POSIX single-quote a value so it is safe to paste into a shell command. */
function shq(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * "Next steps" lines for adding the collected GitHub App source. The primary
 * command inlines the webhook secret; a "Secure alternative" pipes it through
 * stdin from the `printf` builtin, so it never appears in `ps`.
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
 * A warning when the private-key path is unreadable, so the wizard surfaces it
 * without aborting the install (the source is opt-in and secondary).
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
 * Default Platform relay URL; kept in lockstep with the quickstart compose
 * `KICI_PLATFORM_URL`, pinned by orchestrator-wizard.test.ts.
 */
export const DEFAULT_PLATFORM_RELAY_URL = 'wss://api.kici.dev/ws';

/**
 * Asks only the essential questions. The public webhook base URL is required in
 * observed mode and optional in hybrid.
 */
export async function runOrchestratorWizard(
  opts: OrchestratorWizardOptions = {},
): Promise<OrchestratorInstallConfig> {
  console.log('');
  console.log('KiCI orchestrator setup wizard');
  console.log('==============================');
  console.log('');

  const mode = await promptSelect<OrchestratorMode>(
    'Operating mode:',
    [
      {
        name: 'Hybrid (recommended)',
        value: OrchestratorMode.enum.hybrid,
        description: "Platform relay + this orchestrator's own direct webhook ingress",
      },
      {
        name: 'Platform relay',
        value: OrchestratorMode.enum.platform,
        description: 'Connect to KiCI Platform for webhook routing',
      },
      {
        name: 'Observed',
        value: OrchestratorMode.enum.observed,
        description: 'Direct webhooks only (nothing transits KiCI) + hosted dashboard',
      },
      {
        name: 'Independent',
        value: OrchestratorMode.enum.independent,
        description: 'Self-hosted, no Platform dependency',
      },
    ],
    opts.defaultMode ?? OrchestratorMode.enum.hybrid,
  );

  console.log('');
  const databaseUrl = await promptDbUrl();

  const port = await promptPort(4000);

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

  // The bootstrap admin token authenticates `kici-admin` to this orchestrator.
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
  } else if (mode === OrchestratorMode.enum.hybrid) {
    // Optional in hybrid: the relay delivers every webhook, and a public URL lets
    // providers post here too, so a Platform outage drops nothing. Blank keeps
    // relay-only ingestion; the route stays served but unadvertised.
    console.log('');
    console.log("Hybrid also serves this orchestrator's own webhook ingress.");
    console.log('Give its public base URL to have providers post directly, or leave it');
    console.log('blank to start relay-only and set KICI_WEBHOOK_PUBLIC_URL later.');
    webhookPublicUrl = await promptOptionalUrl(
      "This orchestrator's public webhook base URL (optional, blank to skip):",
    );
  }

  // Every mode can hold a GitHub App source.
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
  console.log(`  Public ingress: ${webhookPublicUrl ?? 'not set'}`);
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

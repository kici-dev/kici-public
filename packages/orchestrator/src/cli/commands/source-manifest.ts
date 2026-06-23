/**
 * `kici-admin source add github --manifest` — the one-click GitHub App setup
 * flow. Drives GitHub's App Manifest flow end-to-end: builds a pre-configured
 * manifest (KiCI's exact permissions/events/webhook URL), hands it to GitHub via
 * an auto-submitting form, catches the returned short-lived setup code over a
 * localhost loopback (or copy-paste in --no-browser mode), exchanges it for the
 * App's id + private key + webhook secret, then reuses the existing source
 * storage + Platform-registration path.
 *
 * The private-key-bearing conversion happens entirely here on the orchestrator
 * host — it never transits the Platform (sovereignty invariant).
 */

import { randomBytes } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import type { AdminApiClient } from '../api-client.js';
import {
  buildGithubAppManifest,
  convertManifestCode,
  waitForInstallation,
  verifyRepoAccess,
  type GithubAppCredentials,
} from '../../providers/github/manifest.js';
import { manifestCreateUrl } from '../../providers/github/manifest-form.js';
import { startManifestLoopback, type ManifestLoopback } from '../loopback-callback.js';
import { openBrowserBestEffort } from '../open-browser.js';

/** Static marketing-site page the CLI points at in headless paste-code mode. */
const STATIC_CALLBACK_URL = 'https://kici.dev/gh-manifest-callback';

/** How long to wait for the operator to click "Create" on GitHub. */
const CREATE_TIMEOUT_MS = 5 * 60_000;
/** How long to wait for the operator to install the App on at least one repo. */
const INSTALL_TIMEOUT_MS = 5 * 60_000;
const INSTALL_POLL_MS = 3_000;

export interface ManifestSetupOptions {
  name: string;
  noBrowser?: boolean;
  githubOrg?: string;
}

/** Injectable boundary so unit tests can stub GitHub + the browser + stdin. */
export interface ManifestSetupDeps {
  startLoopback: typeof startManifestLoopback;
  openBrowser: (url: string) => void | Promise<void>;
  readLine: (prompt: string) => Promise<string>;
  convert: (code: string) => Promise<GithubAppCredentials>;
  waitForInstallation: typeof waitForInstallation;
  verifyRepoAccess: typeof verifyRepoAccess;
  /** Persist a created App's PEM to a 0600 file for orphan-app recovery. */
  writeRecoveryFile: (appId: string, pem: string) => string;
}

function defaultReadLine(prompt: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(prompt, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

function defaultWriteRecoveryFile(appId: string, pem: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'kici-gh-app-'));
  const file = join(dir, `app-${appId}.private-key.pem`);
  writeFileSync(file, pem, { mode: 0o600 });
  return file;
}

export const realManifestSetupDeps: ManifestSetupDeps = {
  startLoopback: startManifestLoopback,
  openBrowser: openBrowserBestEffort,
  readLine: defaultReadLine,
  convert: (code) => convertManifestCode(code),
  waitForInstallation,
  verifyRepoAccess,
  writeRecoveryFile: defaultWriteRecoveryFile,
};

/** Resolve the org-scoped webhook URL via the pre-flight route; abort if null. */
async function resolveWebhookUrl(client: AdminApiClient): Promise<string> {
  const pre = await client.get<{ webhookUrl: string | null; webhookNote?: string }>(
    '/api/v1/admin/sources/github-webhook-url',
  );
  if (!pre.webhookUrl) {
    throw new Error(
      `Cannot resolve the GitHub webhook URL${pre.webhookNote ? ` (${pre.webhookNote})` : ''}. ` +
        'The manifest flow needs it to configure the App. Ensure the orchestrator is connected ' +
        'to the Platform and has identified its org, then retry.',
    );
  }
  return pre.webhookUrl;
}

/**
 * Catch the short-lived setup code: over the loopback (browser mode) or by
 * printing the static-site URL and reading the pasted code (headless mode).
 */
async function captureCode(
  opts: ManifestSetupOptions,
  deps: ManifestSetupDeps,
  manifestJson: string,
  state: string,
  redirectUrl: string,
  createUrl: string,
  loopback: ManifestLoopback,
): Promise<string> {
  if (opts.noBrowser) {
    const m = Buffer.from(manifestJson, 'utf-8').toString('base64url');
    const url =
      `${STATIC_CALLBACK_URL}#m=${m}&state=${encodeURIComponent(state)}` +
      `&createUrl=${encodeURIComponent(createUrl)}`;
    console.log('Open this URL in a browser to create your App:');
    console.log(`  ${url}`);
    console.log('After clicking "Create", copy the setup code shown on the page.');
    const code = await deps.readLine('Paste the setup code here: ');
    if (!code) throw new Error('No setup code was provided');
    return code;
  }
  console.log('→ Opening GitHub to create your App…');
  await deps.openBrowser(loopback.formUrl);
  console.log(`  (if your browser did not open, visit ${loopback.formUrl} )`);
  const { code } = await loopback.waitForCode(CREATE_TIMEOUT_MS);
  void redirectUrl;
  return code;
}

/** Store credentials + register; on failure, save the PEM so the App is not orphaned. */
async function storeAndRegister(
  opts: ManifestSetupOptions,
  client: AdminApiClient,
  deps: ManifestSetupDeps,
  creds: GithubAppCredentials,
): Promise<{ routingKey: string }> {
  try {
    return await client.post<{ routingKey: string; name: string }>('/api/v1/admin/sources', {
      provider: 'github',
      name: opts.name,
      appId: creds.appId,
      privateKey: creds.privateKey,
      webhookSecret: creds.webhookSecret,
    });
  } catch (err) {
    const file = deps.writeRecoveryFile(creds.appId, creds.privateKey);
    console.error('');
    console.error('⚠ The GitHub App was created but storing it on the orchestrator failed.');
    console.error(`  App id: ${creds.appId}`);
    console.error(`  Private key saved to: ${file}`);
    console.error('  Recover with:');
    console.error(
      `    kici-admin source add github --name "${opts.name}" --app-id ${creds.appId} ` +
        `--private-key @${file} --webhook-secret ${creds.webhookSecret}`,
    );
    throw err;
  }
}

export async function runGithubManifestSetup(
  opts: ManifestSetupOptions,
  client: AdminApiClient,
  deps: ManifestSetupDeps = realManifestSetupDeps,
): Promise<void> {
  // 1. Resolve the webhook URL BEFORE creating anything on GitHub.
  const webhookUrl = await resolveWebhookUrl(client);

  // 2. Generate the CSRF state. (GitHub generates the webhook secret itself.)
  const state = randomBytes(16).toString('hex');
  const createUrl = manifestCreateUrl(opts.githubOrg);

  // 3. Start the loopback server (also serves the auto-submitting form).
  const loopback = await deps.startLoopback({
    state,
    manifestJson: '{}', // replaced below once redirectUrl is known
    createUrl,
  });
  try {
    const manifest = buildGithubAppManifest({
      name: opts.name,
      webhookUrl,
      redirectUrl: opts.noBrowser ? STATIC_CALLBACK_URL : loopback.redirectUrl,
    });
    const manifestJson = JSON.stringify(manifest);

    // For browser mode the loopback re-serves the form with the real manifest;
    // restart it carrying the manifest so the served form posts the right body.
    loopback.close();
    const lb = await deps.startLoopback({ state, manifestJson, createUrl });
    try {
      // 4–5. Capture the setup code.
      const code = await captureCode(
        opts,
        deps,
        manifestJson,
        state,
        lb.redirectUrl,
        createUrl,
        lb,
      );

      // 6. Exchange code → credentials (private key stays on this host).
      const creds = await deps.convert(code);
      console.log(`→ ✓ App created (id ${creds.appId}), credentials captured`);

      // 7. Store + register (orphan-safe).
      const stored = await storeAndRegister(opts, client, deps, creds);
      console.log(`→ ✓ Stored on orchestrator (encrypted), registered as ${stored.routingKey}`);

      // 8. Guide installation.
      const installUrl = `https://github.com/apps/${creds.slug}/installations/new`;
      console.log(`→ Install the App on your repos: ${installUrl}`);
      if (!opts.noBrowser) await deps.openBrowser(installUrl);

      // 9. Verify install + credentials.
      const { installationId, accountLogin } = await deps.waitForInstallation(creds, {
        timeoutMs: INSTALL_TIMEOUT_MS,
        pollMs: INSTALL_POLL_MS,
      });
      console.log(`→ ✓ Installation detected (account ${accountLogin})`);
      const { repoCount } = await deps.verifyRepoAccess(creds, installationId);
      console.log(`→ ✓ Credentials verified (${repoCount} repositories reachable)`);

      // 10. Done.
      console.log('');
      console.log(`GitHub App "${opts.name}" is live.`);
      console.log(`  Webhook: ${webhookUrl}`);
    } finally {
      lb.close();
    }
  } finally {
    // loopback was already closed above, but closing twice is harmless.
    loopback.close();
  }
}

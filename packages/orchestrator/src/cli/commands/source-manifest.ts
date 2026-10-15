/**
 * `kici-admin source add github --manifest`: GitHub's App Manifest flow end to
 * end. The pre-configured manifest goes to GitHub through an auto-submitting
 * form; the short-lived setup code comes back over a localhost loopback (or is
 * pasted with --no-browser) and is exchanged for the App's id, private key and
 * webhook secret, which take the normal source storage and registration path.
 *
 * The private-key-bearing conversion runs only on the orchestrator host and
 * never transits the Platform (sovereignty invariant).
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
  validateWebhookUrl,
  type GithubAppCredentials,
} from '../../providers/github/manifest.js';
import { manifestCreateUrl } from '../../providers/github/manifest-form.js';
import { startManifestLoopback, type ManifestLoopback } from '../loopback-callback.js';
import { openBrowserBestEffort } from '../open-browser.js';
import { webhookNoteReason, webhookNoteHint } from '../webhook-url-notes.js';

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
  /**
   * Self-hosted webhook URL override, written verbatim into the manifest's
   * `hook_attributes.url` instead of the URL the orchestrator resolves for its
   * mode, so the flow works where that URL is unavailable. KiCI adds no ingress
   * at this URL; the operator owns delivery. Advanced/self-hosted only.
   */
  webhookUrl?: string;
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
      `Cannot resolve the webhook URL for the new GitHub App: ${webhookNoteReason(pre.webhookNote)}. ` +
        webhookNoteHint(pre.webhookNote),
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
    // GitHub's conversion response is the source of truth for name and slug;
    // `opts.name` is only the *requested* name.
    return await client.post<{ routingKey: string; name: string }>('/api/v1/admin/sources', {
      provider: 'github',
      name: creds.name,
      slug: creds.slug,
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
  // Resolve the webhook URL BEFORE creating anything on GitHub. An explicit
  // --webhook-url means the operator owns delivery and is used verbatim.
  const webhookUrl = opts.webhookUrl
    ? validateWebhookUrl(opts.webhookUrl)
    : await resolveWebhookUrl(client);

  // CSRF state; GitHub generates the webhook secret itself.
  const state = randomBytes(16).toString('hex');
  const createUrl = manifestCreateUrl(opts.githubOrg);

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

    // Restart the loopback with the real manifest so its form posts the right body.
    loopback.close();
    const lb = await deps.startLoopback({ state, manifestJson, createUrl });
    try {
      const code = await captureCode(
        opts,
        deps,
        manifestJson,
        state,
        lb.redirectUrl,
        createUrl,
        lb,
      );

      // The private key stays on this host.
      const creds = await deps.convert(code);
      console.log(`→ ✓ App created (id ${creds.appId}), credentials captured`);

      const stored = await storeAndRegister(opts, client, deps, creds);
      console.log(`→ ✓ Stored on orchestrator (encrypted), registered as ${stored.routingKey}`);

      const installUrl = `https://github.com/apps/${creds.slug}/installations/new`;
      console.log(`→ Install the App on your repos: ${installUrl}`);
      if (!opts.noBrowser) await deps.openBrowser(installUrl);

      const { installationId, accountLogin } = await deps.waitForInstallation(creds, {
        timeoutMs: INSTALL_TIMEOUT_MS,
        pollMs: INSTALL_POLL_MS,
      });
      console.log(`→ ✓ Installation detected (account ${accountLogin})`);
      const { repoCount } = await deps.verifyRepoAccess(creds, installationId);
      console.log(`→ ✓ Credentials verified (${repoCount} repositories reachable)`);

      console.log('');
      console.log(`GitHub App "${opts.name}" is live.`);
      console.log(`  Webhook: ${webhookUrl}`);
    } finally {
      lb.close();
    }
  } finally {
    // Already closed above; a second close is harmless.
    loopback.close();
  }
}

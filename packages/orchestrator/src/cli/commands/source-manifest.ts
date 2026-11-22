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
import { toErrorMessage } from '@kici-dev/shared';
import type { AdminApiClient } from '../api-client.js';
import {
  buildGithubAppManifest,
  convertManifestCode,
  waitForInstallation,
  verifyRepoAccess,
  validateWebhookUrl,
  type GithubAppCredentials,
  type ManifestConversionOptions,
} from '../../providers/github/manifest.js';
import { manifestCreateUrl } from '../../providers/github/manifest-form.js';
import { githubAppInstallUrl, isDefaultGithubUrl } from '../../providers/github/github-host.js';
import { startManifestLoopback, type ManifestLoopback } from '../loopback-callback.js';
import { openBrowserBestEffort } from '../open-browser.js';
import { webhookNoteReason, webhookNoteHint } from '../webhook-url-notes.js';
import type { PlatformAttachment } from '../../db/repos/org-ids-repo.js';
import { resolveNewSourceOrg } from '../../sources/source-org.js';

/**
 * Static marketing-site page the CLI points at in headless paste-code mode,
 * unless the orchestrator reports a page its Platform serves itself.
 */
const STATIC_CALLBACK_URL = 'https://kici.dev/gh-manifest-callback';

const PREFLIGHT_PATH = '/api/v1/admin/sources/github-webhook-url';

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
  /** Org the source belongs to; the orchestrator defaults it to the attached org. */
  customerId?: string;
  /**
   * GitHub web URL the App is created on (`--github-url`), already validated
   * with `parseGithubWebUrl`. Unset means github.com.
   */
  githubUrl?: string;
}

/** Injectable boundary so unit tests can stub GitHub + the browser + stdin. */
export interface ManifestSetupDeps {
  startLoopback: typeof startManifestLoopback;
  openBrowser: (url: string) => void | Promise<void>;
  readLine: (prompt: string) => Promise<string>;
  convert: (code: string, opts?: ManifestConversionOptions) => Promise<GithubAppCredentials>;
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
  convert: (code, opts) => convertManifestCode(code, opts),
  waitForInstallation,
  verifyRepoAccess,
  writeRecoveryFile: defaultWriteRecoveryFile,
};

/**
 * Refuse an org the orchestrator would refuse, before an App exists on GitHub:
 * the store route makes the same check, but by then the App is already created.
 * An orchestrator that does not report its attachment skips the pre-check.
 */
async function checkSourceOrg(opts: ManifestSetupOptions, client: AdminApiClient): Promise<void> {
  const list = await client.get<{
    platformAttachment?: PlatformAttachment;
    attachedOrgId?: string | null;
  }>('/api/v1/admin/sources');
  if (!list.platformAttachment) return;
  const org = resolveNewSourceOrg({
    requested: opts.customerId,
    attachment: {
      platformAttachment: list.platformAttachment,
      attachedOrgId: list.attachedOrgId ?? null,
    },
  });
  if (!org.ok) throw new Error(org.error);
}

/** What the orchestrator's manifest pre-flight reports. */
interface ManifestPreflight {
  webhookUrl: string | null;
  webhookNote?: string;
  /** A headless manifest page the orchestrator's Platform serves itself. */
  manifestCallbackUrl?: string;
}

/** Read the manifest pre-flight: the org-scoped webhook URL and the Platform's own page. */
async function readManifestPreflight(client: AdminApiClient): Promise<ManifestPreflight> {
  return client.get<ManifestPreflight>(PREFLIGHT_PATH);
}

/** The message of an orchestrator that predates the pre-flight route or its fields. */
const OLDER_ORCHESTRATOR_ERROR = /^HTTP 4\d\d\b/;

/**
 * Read the pre-flight for its manifest page only (an explicit --webhook-url
 * already fixed the webhook URL), so a pre-flight that cannot be read falls
 * back to the default page. Only a 4xx, an orchestrator without the route, is
 * tolerated silently; any other failure is named before the fallback.
 */
async function readPreflightForPage(
  client: AdminApiClient,
): Promise<ManifestPreflight | undefined> {
  try {
    return await readManifestPreflight(client);
  } catch (err) {
    const message = toErrorMessage(err);
    // fails-when: a 5xx or a transport failure falls back to the default page silently
    // breaks-if-wrong: an older orchestrator's 404 must stay a silent fallback
    if (!OLDER_ORCHESTRATOR_ERROR.test(message)) {
      console.error(
        `Note: could not read the manifest pre-flight (${message}); using the default page`,
      );
    }
    return undefined;
  }
}

/**
 * The headless page kici-admin prints and bakes into the App's redirect URL:
 * the page the orchestrator reports, or the default page. A reported value
 * that is not a plain http(s) URL aborts the flow rather than being printed.
 */
function headlessPageUrl(pre: ManifestPreflight | undefined): string {
  const value = pre?.manifestCallbackUrl;
  if (!value) return STATIC_CALLBACK_URL;
  const refuse = (): never => {
    throw new Error(
      `The orchestrator reported an unusable manifest page URL (${JSON.stringify(value)}): ` +
        'it must be an http:// or https:// URL with no credentials, fragment, whitespace or ' +
        'control character',
    );
  };
  // fails-when: a javascript:, credential-bearing or line-broken value is printed for the
  //   operator to open and baked into the App's redirect URL
  // breaks-if-wrong: http://127.0.0.1:14460/github/manifest-callback (a local install's
  //   page) must still be accepted verbatim
  if (/[\s\u0000-\u001f\u007f]/.test(value)) refuse();
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return refuse();
  }
  if (
    (url.protocol !== 'http:' && url.protocol !== 'https:') ||
    url.username !== '' ||
    url.password !== '' ||
    value.includes('#')
  ) {
    refuse();
  }
  return value;
}

/**
 * The webhook URL baked into the App and the headless page, before anything
 * exists on GitHub. An explicit --webhook-url means the operator owns delivery
 * and is used verbatim; the pre-flight is then read only with --no-browser,
 * for its manifest page. Otherwise the pre-flight supplies the webhook URL, and
 * a null one aborts. The loopback flow neither prints nor bakes the headless
 * page, so only --no-browser uses the reported page.
 */
async function resolveManifestTargets(
  opts: ManifestSetupOptions,
  client: AdminApiClient,
): Promise<{ webhookUrl: string; callbackUrl: string }> {
  if (opts.webhookUrl) {
    const webhookUrl = validateWebhookUrl(opts.webhookUrl);
    // fails-when: the loopback flow reads a pre-flight it uses for nothing
    // breaks-if-wrong: --no-browser must still read it to print the reported page
    const callbackUrl = opts.noBrowser
      ? headlessPageUrl(await readPreflightForPage(client))
      : STATIC_CALLBACK_URL;
    return { webhookUrl, callbackUrl };
  }
  const pre = await readManifestPreflight(client);
  if (!pre.webhookUrl) {
    throw new Error(
      `Cannot resolve the webhook URL for the new GitHub App: ${webhookNoteReason(pre.webhookNote)}. ` +
        webhookNoteHint(pre.webhookNote),
    );
  }
  return {
    webhookUrl: pre.webhookUrl,
    callbackUrl: opts.noBrowser ? headlessPageUrl(pre) : STATIC_CALLBACK_URL,
  };
}

/**
 * Catch the short-lived setup code: over the loopback (browser mode) or by
 * printing the headless page's URL and reading the pasted code.
 */
async function captureCode(
  opts: ManifestSetupOptions,
  deps: ManifestSetupDeps,
  manifestJson: string,
  state: string,
  callbackUrl: string,
  createUrl: string,
  loopback: ManifestLoopback,
): Promise<string> {
  if (opts.noBrowser) {
    const m = Buffer.from(manifestJson, 'utf-8').toString('base64url');
    const url =
      `${callbackUrl}#m=${m}&state=${encodeURIComponent(state)}` +
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
  return code;
}

/** A created App's credentials, with the GitHub Enterprise Server it lives on when there is one. */
type ServerAppCredentials = GithubAppCredentials & { githubUrl?: string };

/** Store credentials + register; on failure, save the PEM so the App is not orphaned. */
async function storeAndRegister(
  opts: ManifestSetupOptions,
  client: AdminApiClient,
  deps: ManifestSetupDeps,
  creds: ServerAppCredentials,
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
      ...(creds.githubUrl && { githubUrl: creds.githubUrl }),
      ...(opts.customerId && { customerId: opts.customerId }),
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
        `--private-key @${file} --webhook-secret ${creds.webhookSecret}` +
        (creds.githubUrl ? ` --github-url ${creds.githubUrl}` : '') +
        (opts.customerId ? ` --org ${opts.customerId}` : ''),
    );
    throw err;
  }
}

export async function runGithubManifestSetup(
  opts: ManifestSetupOptions,
  client: AdminApiClient,
  deps: ManifestSetupDeps = realManifestSetupDeps,
): Promise<void> {
  await checkSourceOrg(opts, client);

  // Resolve the webhook URL BEFORE creating anything on GitHub.
  const { webhookUrl, callbackUrl } = await resolveManifestTargets(opts, client);

  // CSRF state; GitHub generates the webhook secret itself.
  const state = randomBytes(16).toString('hex');
  const createUrl = manifestCreateUrl(opts.githubOrg, opts.githubUrl);

  const loopback = await deps.startLoopback({
    state,
    manifestJson: '{}', // replaced below once redirectUrl is known
    createUrl,
  });
  try {
    const manifest = buildGithubAppManifest({
      name: opts.name,
      webhookUrl,
      redirectUrl: opts.noBrowser ? callbackUrl : loopback.redirectUrl,
    });
    const manifestJson = JSON.stringify(manifest);

    // Restart the loopback with the real manifest so its form posts the right body.
    loopback.close();
    const lb = await deps.startLoopback({ state, manifestJson, createUrl });
    try {
      const code = await captureCode(opts, deps, manifestJson, state, callbackUrl, createUrl, lb);

      // The private key stays on this host. The code is exchanged on the API of
      // the host the App was created on: github.com without --github-url.
      const converted = await (opts.githubUrl
        ? deps.convert(code, { githubUrl: opts.githubUrl })
        : deps.convert(code));
      console.log(`→ ✓ App created (id ${converted.appId}), credentials captured`);

      // Every later step talks to the App's server: storing it, the install
      // wait and the access check. A github.com App carries no server.
      // fails-when: a GitHub Enterprise Server App is stored and checked as a github.com App
      // breaks-if-wrong: an explicit --github-url https://github.com keeps today's credentials
      const creds: ServerAppCredentials = {
        ...converted,
        ...(!isDefaultGithubUrl(opts.githubUrl) && { githubUrl: opts.githubUrl }),
      };
      const stored = await storeAndRegister(opts, client, deps, creds);
      console.log(`→ ✓ Stored on orchestrator (encrypted), registered as ${stored.routingKey}`);

      const installUrl = githubAppInstallUrl(creds.githubUrl, creds.slug);
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

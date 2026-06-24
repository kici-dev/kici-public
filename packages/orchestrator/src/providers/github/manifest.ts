/**
 * GitHub App Manifest flow helpers. The manifest encodes KiCI's exact
 * permissions + events + webhook config so the operator never picks them by
 * hand — GitHub creates a correctly-configured App from this object in one
 * click. See docs.github.com "Registering a GitHub App from a manifest".
 *
 * The webhook secret is NOT part of the manifest: GitHub generates it during
 * registration and returns it on the conversion response, so both GitHub and
 * the Platform end up sharing the same secret with zero operator effort.
 */

import { Octokit } from '@octokit/rest';
import { createAppAuth } from '@octokit/auth-app';
import { createInstallationOctokit } from './auth.js';

export interface GithubManifestInput {
  /** App name shown on GitHub. */
  name: string;
  /** Full https webhook URL (org-scoped) GitHub will POST events to. */
  webhookUrl: string;
  /** Loopback or static-page callback GitHub redirects to with the setup code. */
  redirectUrl: string;
  /** Optional post-install redirect. */
  setupUrl?: string;
}

/** The JSON object GitHub's create-from-manifest endpoint expects. */
export interface GithubAppManifest {
  name: string;
  url: string;
  hook_attributes: { url: string; active: boolean };
  redirect_url: string;
  setup_url?: string;
  public: boolean;
  default_permissions: Record<string, string>;
  default_events: string[];
}

/**
 * Validate a self-hosted webhook URL supplied via `source add github
 * --webhook-url`. Must be a well-formed absolute `https://` URL. Returns the URL
 * verbatim on success; throws a clear error otherwise. The validated URL is
 * baked into `manifest.hook_attributes.url` as-is — KiCI adds no ingress and
 * does not receive events at it; the operator owns delivery.
 */
export function validateWebhookUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`--webhook-url must be a valid absolute URL: ${value}`);
  }
  if (url.protocol !== 'https:') {
    throw new Error(`--webhook-url must be an https:// URL (got ${url.protocol}//…)`);
  }
  return value;
}

export function buildGithubAppManifest(input: GithubManifestInput): GithubAppManifest {
  return {
    name: input.name,
    url: 'https://kici.dev',
    hook_attributes: { url: input.webhookUrl, active: true },
    redirect_url: input.redirectUrl,
    ...(input.setupUrl ? { setup_url: input.setupUrl } : {}),
    public: false,
    default_permissions: {
      contents: 'read',
      metadata: 'read',
      pull_requests: 'read',
      checks: 'write',
      members: 'read',
    },
    default_events: ['push', 'pull_request', 'check_run', 'check_suite'],
  };
}

/** Credentials returned by GitHub's manifest-conversion endpoint. */
export interface GithubAppCredentials {
  appId: string;
  slug: string;
  /** GitHub's display name for the App (the authoritative stored name). */
  name: string;
  privateKey: string;
  webhookSecret: string;
  clientId?: string;
  clientSecret?: string;
  htmlUrl?: string;
}

/**
 * Exchange the short-lived manifest `code` for the App's id, private key, and
 * webhook secret. Runs server-to-server directly against GitHub — the private
 * key never transits the Platform.
 */
export async function convertManifestCode(
  code: string,
  deps: { octokit?: Pick<Octokit, 'request'> } = {},
): Promise<GithubAppCredentials> {
  const octokit = deps.octokit ?? new Octokit();
  const { data } = await octokit.request('POST /app-manifests/{code}/conversions', { code });
  const d = data as {
    id: number;
    slug: string;
    name: string;
    pem: string;
    webhook_secret: string | null;
    client_id?: string;
    client_secret?: string;
    html_url?: string;
  };
  if (!d.webhook_secret) {
    throw new Error(
      'GitHub returned no webhook secret for the new App — cannot verify inbound events. ' +
        'Re-run the setup, or configure a webhook secret manually with source update.',
    );
  }
  return {
    appId: String(d.id),
    slug: d.slug,
    name: d.name,
    privateKey: d.pem,
    webhookSecret: d.webhook_secret,
    clientId: d.client_id,
    clientSecret: d.client_secret,
    htmlUrl: d.html_url,
  };
}

function appOctokitFor(creds: Pick<GithubAppCredentials, 'appId' | 'privateKey'>): Octokit {
  return new Octokit({
    authStrategy: createAppAuth,
    auth: { appId: creds.appId, privateKey: creds.privateKey },
  });
}

/**
 * Ask GitHub who this App is (`GET /app`, authenticated as the App via its
 * JWT) and return its authoritative display `name` + `slug`. This is the single
 * "fetch the App's identity from GitHub" helper, reused at source creation, by
 * the daily refresher, and by `kici-admin source refresh`.
 *
 * GitHub is the source of truth: a rename in the GitHub UI changes the value
 * `GET /app` returns, which is what keeps the dashboard name fresh.
 */
export async function fetchGithubAppIdentity(
  creds: Pick<GithubAppCredentials, 'appId' | 'privateKey'>,
  deps: { appOctokit?: Pick<Octokit, 'request'> } = {},
): Promise<{ name: string; slug: string }> {
  const octokit = deps.appOctokit ?? appOctokitFor(creds);
  const { data } = await octokit.request('GET /app');
  const d = data as { name: string; slug: string };
  return { name: d.name, slug: d.slug };
}

/**
 * Poll GitHub (as the App, via a JWT) until at least one installation exists,
 * returning the first installation's id + account login. Throws on timeout.
 */
export async function waitForInstallation(
  creds: Pick<GithubAppCredentials, 'appId' | 'privateKey'>,
  opts: {
    timeoutMs: number;
    pollMs: number;
    now?: () => number;
    appOctokit?: Pick<Octokit, 'request'>;
  },
): Promise<{ installationId: number; accountLogin: string }> {
  const now = opts.now ?? Date.now;
  const octokit = opts.appOctokit ?? appOctokitFor(creds);
  const deadline = now() + opts.timeoutMs;
  for (;;) {
    const { data } = await octokit.request('GET /app/installations', { per_page: 1 });
    const installs = data as Array<{ id: number; account?: { login?: string } | null }>;
    if (Array.isArray(installs) && installs.length > 0) {
      return { installationId: installs[0].id, accountLogin: installs[0].account?.login ?? '' };
    }
    if (now() >= deadline) {
      throw new Error('Timed out waiting for the GitHub App to be installed');
    }
    await new Promise((r) => setTimeout(r, opts.pollMs));
  }
}

/**
 * Mint an installation token from the captured private key and confirm the App
 * can reach repos — proves the key works end-to-end (the same path the agent's
 * clone uses at runtime).
 */
export async function verifyRepoAccess(
  creds: Pick<GithubAppCredentials, 'appId' | 'privateKey'>,
  installationId: number,
  deps: { octokit?: Pick<Octokit, 'request'> } = {},
): Promise<{ repoCount: number }> {
  const octokit = deps.octokit ?? createInstallationOctokit(creds, installationId);
  const { data } = await octokit.request('GET /installation/repositories', { per_page: 1 });
  return { repoCount: (data as { total_count: number }).total_count };
}

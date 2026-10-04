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
import { createAppOctokit, createInstallationOctokit } from './auth.js';

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

/** Access levels of a GitHub App permission, lowest first. */
const PERMISSION_LEVELS = ['read', 'write', 'admin'] as const;
type GithubPermissionLevel = (typeof PERMISSION_LEVELS)[number];

/**
 * Every permission and event a KiCI GitHub App needs. The manifest requests
 * exactly these, and `kici-admin source refresh` reports an existing App that
 * lacks any of them.
 */
export const GITHUB_APP_REQUIREMENTS = {
  permissions: {
    contents: 'read',
    metadata: 'read',
    pull_requests: 'read',
    checks: 'write',
    members: 'read',
    // GitHub subscribes an App to `issue_comment` only with Issues read access.
    // The event carries `/kici approve|reject` PR comments and the comments
    // `comment()` triggers match.
    issues: 'read',
  },
  events: ['push', 'pull_request', 'check_run', 'check_suite', 'issue_comment'],
} as const satisfies {
  permissions: Record<string, GithubPermissionLevel>;
  events: readonly string[];
};

/** Organization permissions; an installation on a user account cannot hold them. */
const ORGANIZATION_PERMISSIONS: ReadonlySet<string> = new Set(['members']);

/**
 * Events GitHub subscribes an App to automatically once it holds a permission
 * level, without listing them in `GET /app`'s `events`. An App with Checks
 * write receives `check_run` and `check_suite`.
 */
const IMPLICIT_EVENT_GRANTS: Readonly<Record<string, readonly [string, GithubPermissionLevel]>> = {
  check_run: ['checks', 'write'],
  check_suite: ['checks', 'write'],
};

export function buildGithubAppManifest(input: GithubManifestInput): GithubAppManifest {
  return {
    name: input.name,
    url: 'https://kici.dev',
    hook_attributes: { url: input.webhookUrl, active: true },
    redirect_url: input.redirectUrl,
    ...(input.setupUrl ? { setup_url: input.setupUrl } : {}),
    public: false,
    default_permissions: { ...GITHUB_APP_REQUIREMENTS.permissions },
    default_events: [...GITHUB_APP_REQUIREMENTS.events],
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

/** What `GET /app` says about the App: identity plus its grant. */
export interface GithubAppIdentity {
  name: string;
  slug: string;
  /** Events the App subscribes to. */
  events: string[];
  /** The App's permissions, name → access level. */
  permissions: Record<string, string>;
}

/**
 * Ask GitHub who this App is (`GET /app`, authenticated as the App via its
 * JWT) and return its authoritative display `name` + `slug`, plus the events
 * and permissions the App holds, which the requirement gap check reads. This is
 * the single "fetch the App's identity from GitHub" helper, reused at source
 * creation, by the daily refresher, and by `kici-admin source refresh`.
 *
 * GitHub is the source of truth: a rename in the GitHub UI changes the value
 * `GET /app` returns, which is what keeps the dashboard name fresh.
 */
export async function fetchGithubAppIdentity(
  creds: Pick<GithubAppCredentials, 'appId' | 'privateKey'>,
  deps: { appOctokit?: Pick<Octokit, 'request'> } = {},
): Promise<GithubAppIdentity> {
  const octokit = deps.appOctokit ?? createAppOctokit(creds);
  const { data } = await octokit.request('GET /app');
  const d = data as {
    name: string;
    slug: string;
    events?: string[];
    permissions?: Record<string, string>;
  };
  return { name: d.name, slug: d.slug, events: d.events ?? [], permissions: d.permissions ?? {} };
}

/** One installation's grant, as the gap check reads it. */
export interface GithubAppInstallationGrant {
  id: number;
  /** Login of the account the App is installed on (an enterprise's slug). */
  account: string;
  /** `Organization`, `User`, or null for an enterprise installation. */
  accountType: string | null;
  permissions: Record<string, string>;
}

const INSTALLATIONS_PAGE_SIZE = 100;

/** Every installation of the App (`GET /app/installations`, all pages), as the App. */
export async function listGithubAppInstallations(
  creds: Pick<GithubAppCredentials, 'appId' | 'privateKey'>,
  deps: { appOctokit?: Pick<Octokit, 'request'> } = {},
): Promise<GithubAppInstallationGrant[]> {
  const octokit = deps.appOctokit ?? createAppOctokit(creds);
  const grants: GithubAppInstallationGrant[] = [];
  for (let page = 1; ; page++) {
    const { data } = await octokit.request('GET /app/installations', {
      per_page: INSTALLATIONS_PAGE_SIZE,
      page,
    });
    const rows = data as Array<{
      id: number;
      account?: { login?: string; slug?: string; type?: string } | null;
      permissions?: Record<string, string>;
    }>;
    for (const r of rows) {
      grants.push({
        id: r.id,
        account: r.account?.login ?? r.account?.slug ?? '',
        accountType: r.account?.type ?? null,
        permissions: r.permissions ?? {},
      });
    }
    if (rows.length < INSTALLATIONS_PAGE_SIZE) return grants;
  }
}

/** Required events and permissions an App or its installations lack. */
export interface GithubAppRequirementGaps {
  missingEvents: string[];
  missingPermissions: string[];
  /** Installations that have not accepted a permission the App itself holds. */
  installationsPendingApproval: Array<{
    installationId: number;
    account: string;
    missingPermissions: string[];
  }>;
}

/**
 * Whether `actual` grants at least `required`. A higher level satisfies a lower
 * one; a missing or unknown level string grants nothing.
 */
function grantsLevel(actual: string | undefined, required: GithubPermissionLevel): boolean {
  const held = PERMISSION_LEVELS.indexOf(actual as GithubPermissionLevel);
  return held >= 0 && held >= PERMISSION_LEVELS.indexOf(required);
}

/** Whether the App receives an event: listed in its subscription, or implied by a permission. */
function receivesEvent(
  app: Pick<GithubAppIdentity, 'events' | 'permissions'>,
  event: string,
): boolean {
  if (app.events.includes(event)) return true;
  const implied = IMPLICIT_EVENT_GRANTS[event];
  return implied !== undefined && grantsLevel(app.permissions[implied[0]], implied[1]);
}

/** Compare an App and its installations with {@link GITHUB_APP_REQUIREMENTS}. */
export function findGithubAppRequirementGaps(
  app: Pick<GithubAppIdentity, 'events' | 'permissions'>,
  installations: GithubAppInstallationGrant[],
): GithubAppRequirementGaps {
  const required = Object.entries(GITHUB_APP_REQUIREMENTS.permissions) as Array<
    [string, GithubPermissionLevel]
  >;
  const appHolds = ([name, level]: [string, GithubPermissionLevel]) =>
    grantsLevel(app.permissions[name], level);
  return {
    missingEvents: GITHUB_APP_REQUIREMENTS.events.filter((e) => !receivesEvent(app, e)),
    missingPermissions: required.filter((r) => !appHolds(r)).map(([name]) => name),
    installationsPendingApproval: installations.flatMap((inst) => {
      const missing = required
        .filter(
          ([name]) => inst.accountType === 'Organization' || !ORGANIZATION_PERMISSIONS.has(name),
        )
        .filter((r) => appHolds(r) && !grantsLevel(inst.permissions[r[0]], r[1]))
        .map(([name]) => name);
      return missing.length > 0
        ? [{ installationId: inst.id, account: inst.account, missingPermissions: missing }]
        : [];
    }),
  };
}

/** Whether any gap array is non-empty. */
export function hasRequirementGaps(gaps: GithubAppRequirementGaps): boolean {
  return (
    gaps.missingEvents.length +
      gaps.missingPermissions.length +
      gaps.installationsPendingApproval.length >
    0
  );
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
  const octokit = opts.appOctokit ?? createAppOctokit(creds);
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

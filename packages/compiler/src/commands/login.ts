import { createInterface } from 'node:readline';
import os from 'node:os';
import pc from 'picocolors';
import {
  loadGlobalConfig,
  saveGlobalConfig,
  getConfigPath,
  type GlobalConfig,
} from '../remote/config.js';
import { pkceFlow, deviceFlow, exchangeTokenForPat } from '../remote/oauth.js';
import { LoginTargetSource, resolveLoginTarget } from '../remote/login-target.js';
import { parseScopeList } from '../remote/oidc-scopes.js';
import { OidcScopeToken } from '@kici-dev/engine';
import { isHeadless } from '../auth/headless-detect.js';
import { toErrorMessage } from '@kici-dev/core';
import { planeStatus, attachPlane } from '../local-plane/plane-manager.js';

export interface LoginOptions {
  platformEndpoint?: string;
  oidcIssuer?: string;
  /**
   * `--routing-key`: still written to the config, never read.
   *
   * @deprecated Nothing reads the saved value; removed in v1.0.0.
   */
  routingKey?: string;
  /** Force the device flow regardless of environment. */
  device?: boolean;
  /** `--oidc-scope` values: extra scopes requested after `KICI_OIDC_EXTRA_SCOPES`. */
  oidcScopes?: string[];
  /** Skip the post-login "attach the local dev plane?" prompt (scripted logins). */
  noAttachPrompt?: boolean;
}

/** Trimmed answer; the prompt goes to stderr. */
async function promptInput(prompt: string): Promise<string> {
  const rl = createInterface({
    input: process.stdin,
    output: process.stderr,
  });

  return new Promise<string>((resolve) => {
    rl.question(prompt, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

/** Warn when the PAT expires within 7 days. */
function checkPatExpiry(expiresAt: string): void {
  const expiryDate = new Date(expiresAt);
  const now = new Date();
  const daysUntilExpiry = (expiryDate.getTime() - now.getTime()) / (1000 * 60 * 60 * 24);

  if (daysUntilExpiry <= 7 && daysUntilExpiry > 0) {
    console.log(
      pc.yellow(
        `\n  Warning: your personal access token expires in ${Math.ceil(daysUntilExpiry)} day(s) (${expiryDate.toLocaleDateString()}).`,
      ),
    );
    console.log(pc.yellow('  Run `kici login` again to refresh it.'));
  }
}

/** The user's extra scopes (env, then flags); throws on a value that is not one scope token. */
function userExtraScopes(oidcScopes: readonly string[] | undefined): string[] {
  const sources: Array<[string, string[]]> = [
    ['KICI_OIDC_EXTRA_SCOPES', parseScopeList(process.env.KICI_OIDC_EXTRA_SCOPES)],
    ['--oidc-scope', (oidcScopes ?? []).flatMap((value) => parseScopeList(value))],
  ];
  for (const [source, scopes] of sources) {
    // fails-when: a scope with a quote or a backslash reaches the identity provider's scope parameter
    const invalid = scopes.find((scope) => !OidcScopeToken.safeParse(scope).success);
    if (invalid !== undefined) {
      throw new Error(
        `${source}: "${invalid}" is not an OIDC scope (a scope has no quotes, backslashes or control characters)`,
      );
    }
  }
  return sources.flatMap(([, scopes]) => scopes);
}

/** PKCE or device flow → OIDC access token → PAT saved to the global config. */
async function oauthLogin(options: LoginOptions): Promise<boolean> {
  const userScopes = userExtraScopes(options.oidcScopes);
  // Hosted defaults; flags, KICI_* env vars and a named Platform's login settings
  // override. Resolution never writes process.env, so the orchestrator's WS
  // reading of KICI_PLATFORM_URL is untouched.
  const existing = await loadGlobalConfig();
  const { platformUrl, issuer, clientId, source, extraScopes } = await resolveLoginTarget({
    platformEndpoint: options.platformEndpoint,
    oidcIssuer: options.oidcIssuer,
    env: process.env,
  });

  console.log(pc.cyan('\n  Step 1/4: Detecting environment...'));
  if (source === LoginTargetSource.enum.platform_published) {
    const published = extraScopes.length > 0 ? `, extra scopes: ${extraScopes.join(' ')}` : '';
    console.log(
      pc.gray(`  Using identity provider ${issuer} (published by ${platformUrl})${published}`),
    );
  }
  // A set KICI_BROWSER_CMD (even 'none') is explicit browser config: skip
  // headless detection and use PKCE. --device still forces the device flow.
  const browserCmdSet = !!process.env.KICI_BROWSER_CMD;
  const useDeviceFlow = options.device || (!browserCmdSet && (await isHeadless()));
  const flowName = useDeviceFlow ? 'device authorization' : 'PKCE (browser)';
  console.log(pc.gray(`  Using ${flowName} flow`));

  console.log(pc.cyan(`\n  Step 2/4: Authenticating with IdP (${flowName})...`));
  let accessToken: string;
  const scopes = [...new Set([...userScopes, ...extraScopes])];
  const oauthOpts = { issuer, clientId, ...(scopes.length > 0 && { extraScopes: scopes }) };
  if (useDeviceFlow) {
    accessToken = await deviceFlow(oauthOpts);
  } else {
    accessToken = await pkceFlow(oauthOpts);
  }

  console.log(pc.cyan('\n  Step 3/4: Exchanging token for personal access token...'));
  const machineName = os.hostname();
  const patResult = await exchangeTokenForPat({
    platformUrl,
    accessToken,
    machineName,
  });

  console.log(pc.cyan('\n  Step 4/4: Saving credentials...'));

  const endpointChanged = existing.platformEndpoint !== platformUrl;

  const next: GlobalConfig = {
    ...existing,
    pat: patResult.token,
    patId: patResult.id,
    patExpiresAt: patResult.expiresAt,
    platformEndpoint: platformUrl,
    oidcIssuer: issuer,
  };

  if (options.routingKey) {
    // Deprecated: kept writing until v1.0.0 so the flag keeps its old effect.
    console.error(
      pc.yellow(
        '--routing-key is deprecated and has no effect: nothing reads the saved value. It will be removed in v1.0.0.',
      ),
    );
    next.routingKey = options.routingKey;
  }

  // A new endpoint invalidates activeOrgId and defaultClusters; `kici org use` re-selects.
  if (endpointChanged) {
    delete next.activeOrgId;
    delete next.defaultClusters;
  }

  await saveGlobalConfig(next);

  const configPath = getConfigPath();
  const expiryDate = new Date(patResult.expiresAt).toLocaleDateString();
  console.log(pc.green(`\n  Authenticated successfully!`));
  console.log(pc.gray(`  PAT expires: ${expiryDate}`));
  console.log(pc.gray(`  Config saved to ${configPath}`));

  checkPatExpiry(patResult.expiresAt);

  await maybePromptAttach(options, {
    apiBase: platformUrl,
    pat: patResult.token,
    orgId: next.activeOrgId,
  });

  return true;
}

/**
 * Offer to attach the local dev plane so `kici run --local` uses real Platform
 * identity. Skipped for non-TTY input, `--no-attach`, no selected org, or an
 * attached plane. Non-fatal: login has already succeeded.
 */
async function maybePromptAttach(
  options: LoginOptions,
  ctx: { apiBase: string; pat: string; orgId?: string },
): Promise<void> {
  try {
    if (options.noAttachPrompt) return;
    if (!process.stdin.isTTY) return;
    if (!ctx.orgId) {
      console.log(
        pc.gray(
          '\n  Tip: select an org (`kici org use <org>`) then `kici local attach` to use ' +
            'real Platform identity for `kici run --local`.',
        ),
      );
      return;
    }
    const current = await planeStatus();
    if (current.mode === 'hybrid') return;

    console.log(
      "\n  You don't have your local dev plane attached to the Platform.\n" +
        '  Attach it so `kici run --local` uses real Platform secrets & identity?',
    );
    const answer = (await promptInput('  Attach now? [Y/n] ')).toLowerCase();
    if (answer === 'n' || answer === 'no') {
      console.log(pc.gray('  Left offline. Re-attach later with `kici local attach`.'));
      return;
    }
    console.log(pc.cyan('\n  Attaching the local dev plane…'));
    const status = await attachPlane({ apiBase: ctx.apiBase, pat: ctx.pat, orgId: ctx.orgId });
    console.log(
      pc.green(
        `  ✓ Attached (hybrid) at ${status.url ?? ''} — \`kici run --local\` is now connected.`,
      ),
    );
  } catch (err) {
    console.log(pc.yellow(`  Could not attach the local dev plane: ${toErrorMessage(err)}`));
    console.log(pc.gray('  Login succeeded; attach later with `kici local attach`.'));
  }
}

/** OAuth login: PKCE on a desktop, the device flow headless or with `--device`. */
export async function loginCommand(options: LoginOptions): Promise<boolean> {
  try {
    return await oauthLogin(options);
  } catch (err: unknown) {
    const message = toErrorMessage(err);
    console.error(pc.red(`\n  Login failed: ${message}`));
    return false;
  }
}

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
import {
  PROD_PLATFORM_URL,
  PROD_OIDC_ISSUER,
  PROD_OIDC_CLIENT_ID,
} from '../remote/prod-defaults.js';
import { isHeadless } from '../auth/headless-detect.js';
import { toErrorMessage } from '@kici-dev/core';
import { planeStatus, attachPlane } from '../local-plane/plane-manager.js';

export interface LoginOptions {
  /** Platform relay URL */
  platformEndpoint?: string;
  /** OIDC issuer URL override */
  oidcIssuer?: string;
  /**
   * `--routing-key`: still written to the config, never read.
   *
   * @deprecated Nothing reads the saved value; removed in v1.0.0.
   */
  routingKey?: string;
  /** Force device authorization flow regardless of environment */
  device?: boolean;
  /** Skip the post-login "attach the local dev plane?" prompt (scripted logins). */
  noAttachPrompt?: boolean;
}

/**
 * Prompt the user for input via stdin.
 * Returns the trimmed input string.
 */
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

/**
 * Check if a PAT is expiring within 7 days and print a warning.
 */
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

/**
 * Run the OAuth authentication flow (PKCE or device flow).
 *
 * Steps:
 * 1. Detect environment (headless vs desktop)
 * 2. Run appropriate OAuth flow to get OIDC access token
 * 3. Exchange OIDC token for a personal access token (PAT)
 * 4. Save PAT to global config
 */
async function oauthLogin(options: LoginOptions): Promise<boolean> {
  // Default to the hosted KiCI Platform so `kici login` works with zero
  // configuration. Each value is overridable: the --platform-endpoint flag
  // and the KICI_* env vars take precedence. Resolution stays local — never
  // written to process.env — so the orchestrator's WS reading of
  // KICI_PLATFORM_URL is untouched.
  const existing = await loadGlobalConfig();
  const platformUrl =
    options.platformEndpoint || process.env.KICI_PLATFORM_URL || PROD_PLATFORM_URL;
  const issuer = options.oidcIssuer || process.env.KICI_OIDC_ISSUER || PROD_OIDC_ISSUER;
  const clientId = process.env.KICI_OIDC_CLIENT_ID || PROD_OIDC_CLIENT_ID;

  // Step 1: Detect environment
  console.log(pc.cyan('\n  Step 1/4: Detecting environment...'));
  // If KICI_BROWSER_CMD is set (even to 'none'), the user explicitly configured browser handling,
  // so skip headless auto-detection and use PKCE. The --device flag still forces device flow.
  const browserCmdSet = !!process.env.KICI_BROWSER_CMD;
  const useDeviceFlow = options.device || (!browserCmdSet && (await isHeadless()));
  const flowName = useDeviceFlow ? 'device authorization' : 'PKCE (browser)';
  console.log(pc.gray(`  Using ${flowName} flow`));

  // Step 2: Authenticate with the IdP
  console.log(pc.cyan(`\n  Step 2/4: Authenticating with IdP (${flowName})...`));
  let accessToken: string;
  const oauthOpts = { issuer, clientId };
  if (useDeviceFlow) {
    accessToken = await deviceFlow(oauthOpts);
  } else {
    accessToken = await pkceFlow(oauthOpts);
  }

  // Step 3: Exchange token for PAT
  console.log(pc.cyan('\n  Step 3/4: Exchanging token for personal access token...'));
  const machineName = os.hostname();
  const patResult = await exchangeTokenForPat({
    platformUrl,
    accessToken,
    machineName,
  });

  // Step 4: Save credentials
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

  // activeOrgId + defaultClusters belong to a specific environment; a new
  // endpoint invalidates them, so drop them and let `kici org use` re-select.
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

  // Check for near-expiry warning
  checkPatExpiry(patResult.expiresAt);

  // Offer to attach the local dev plane so `kici run --local` uses real
  // Platform identity. Interactive + opt-out only.
  await maybePromptAttach(options, {
    apiBase: platformUrl,
    pat: patResult.token,
    orgId: next.activeOrgId,
  });

  return true;
}

/**
 * After a successful login, prompt an interactive user to attach their local
 * dev plane to the Platform. Skipped entirely for non-TTY / piped input, when
 * `--no-attach` is set, when no org is selected (nothing to attach against), or
 * when a plane is already attached. Any failure here is non-fatal — login has
 * already succeeded.
 */
async function maybePromptAttach(
  options: LoginOptions,
  ctx: { apiBase: string; pat: string; orgId?: string },
): Promise<void> {
  try {
    if (options.noAttachPrompt) return;
    // Only prompt for a genuinely interactive terminal.
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
    if (current.mode === 'hybrid') return; // already attached

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

/**
 * Authenticate with KiCI.
 *
 * - Runs the OAuth flow: PKCE (desktop) or device (headless)
 * - With `--device`, forces device authorization flow
 *
 * Returns true on success, false on error.
 */
export async function loginCommand(options: LoginOptions): Promise<boolean> {
  try {
    return await oauthLogin(options);
  } catch (err: unknown) {
    const message = toErrorMessage(err);
    console.error(pc.red(`\n  Login failed: ${message}`));
    return false;
  }
}

/**
 * Applies private-npm-registry auth to a workflow's `.kici/.npmrc` for one
 * `npm install`, then restores the file on cleanup. The closure cleanup
 * (like `setupSshAuth.cleanup()` in `checkout/git-clone.ts`) exists because
 * the committed `.kici/.npmrc` may carry literal `${VAR}` placeholders or
 * unrelated scope mappings that must NOT be clobbered permanently.
 *
 * Token bytes never reach the on-disk `.npmrc`: each token is a job-scoped env
 * var (`KICI_NPM_TOKEN_${jobIdShort}_<i>`), the auth line carries `${VAR}`, and
 * npm substitutes at read time. The job-scoped nonce makes the name
 * unguessable from outside the install subprocess.
 *
 * Customer lines come FIRST, agent lines LAST: npm's last-wins makes the
 * managed line shadow any literal `_authToken=...` committed for a registry
 * KiCI manages.
 *
 * `installEnvSecrets` is a separate channel for the "commit `${MY_TOKEN}` in
 * `.kici/.npmrc` and supply MY_TOKEN as a scoped secret" pattern: each entry
 * becomes an env var on the install subprocess.
 */

import { readFile, writeFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';

/** Registry spec carried on the dispatch message (token already resolved). */
export interface NpmRegistrySpec {
  url: string;
  scope?: string;
  alwaysAuth: boolean;
  token: string;
}

export interface ApplyNpmRegistryConfigArgs {
  /** Absolute path to the workflow's `.kici/` directory. */
  kiciDir: string;
  npmRegistries: readonly NpmRegistrySpec[] | undefined;
  /** Bare-name resolved secrets to project as install env vars. */
  installEnvSecrets: Record<string, string> | undefined;
  /** Short (8 char) job-scoped nonce, the suffix of synthesized env-var names. */
  jobIdShort: string;
  /**
   * Disable lifecycle scripts (default true). Read by the berry flavor, which
   * controls them through `.yarnrc.yml` (`enableScripts`), not a CLI flag.
   */
  ignoreScripts?: boolean;
}

export interface ApplyNpmRegistryConfigResult {
  /** Env vars to merge into the install subprocess (token vars + installEnvSecrets). */
  extraEnv: Record<string, string>;
  /** Token bytes the caller MUST mask out of stdout/stderr before logging. */
  tokensForRedaction: string[];
  /** Restore `.kici/.npmrc` to its pre-call state. Idempotent; never throws. */
  cleanup: () => Promise<void>;
}

function noopResult(): ApplyNpmRegistryConfigResult {
  return {
    extraEnv: {},
    tokensForRedaction: [],
    cleanup: async () => {},
  };
}

export function tokenEnvName(jobIdShort: string, index: number): string {
  return `KICI_NPM_TOKEN_${jobIdShort}_${index}`;
}

export function renderAgentLines(
  registries: readonly NpmRegistrySpec[],
  jobIdShort: string,
): string {
  if (registries.length === 0) return '';
  const lines: string[] = [];
  for (let i = 0; i < registries.length; i++) {
    const reg = registries[i];
    const envVar = tokenEnvName(jobIdShort, i);
    // npm's auth-token key is `//host/path/` (RFC 3986 authority + path, no
    // scheme); http and https map to the same key, so an http-toggled
    // registry still authenticates.
    const authKey = reg.url.replace(/^https?:/, '');
    if (reg.scope) {
      lines.push(`${reg.scope}:registry=${reg.url}`);
    } else {
      lines.push(`registry=${reg.url}`);
    }
    lines.push(`${authKey}:_authToken=\${${envVar}}`);
    if (reg.alwaysAuth) {
      lines.push(`${authKey}:always-auth=true`);
    }
  }
  return `# kici-managed: applied for one npm install only\n${lines.join('\n')}\n`;
}

/** Null when the file does not exist. */
async function readOriginalNpmrc(npmrcPath: string): Promise<string | null> {
  try {
    return await readFile(npmrcPath, 'utf8');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return null;
    throw err;
  }
}

/** The caller runs the install with `extraEnv` merged in and awaits cleanup() in its `finally`. */
export async function applyNpmRegistryConfig(
  args: ApplyNpmRegistryConfigArgs,
): Promise<ApplyNpmRegistryConfigResult> {
  const registries = args.npmRegistries ?? [];
  const installEnvSecrets = args.installEnvSecrets ?? {};
  if (registries.length === 0 && Object.keys(installEnvSecrets).length === 0) {
    return noopResult();
  }

  const npmrcPath = join(args.kiciDir, '.npmrc');
  const original = await readOriginalNpmrc(npmrcPath);

  const tokenEnv: Record<string, string> = {};
  const tokensForRedaction: string[] = [];
  for (let i = 0; i < registries.length; i++) {
    tokenEnv[tokenEnvName(args.jobIdShort, i)] = registries[i].token;
    tokensForRedaction.push(registries[i].token);
  }
  for (const value of Object.values(installEnvSecrets)) {
    if (value) tokensForRedaction.push(value);
  }

  const agentBlock = renderAgentLines(registries, args.jobIdShort);
  // Customer first, agent last (npm last-wins).
  const merged = `${original ?? ''}${
    original && !original.endsWith('\n') ? '\n' : ''
  }${agentBlock}`;

  if (agentBlock.length > 0) {
    await writeFile(npmrcPath, merged, { encoding: 'utf8', mode: 0o600 });
  }

  const cleanup = async (): Promise<void> => {
    if (agentBlock.length === 0) return;
    try {
      if (original === null) {
        await unlink(npmrcPath).catch(() => {});
      } else {
        await writeFile(npmrcPath, original, { encoding: 'utf8' });
      }
    } catch {
      // Cleanup is best-effort; never fail the install on a restore error.
    }
  };

  return {
    extraEnv: { ...installEnvSecrets, ...tokenEnv },
    tokensForRedaction,
    cleanup,
  };
}

export function redactNpmOutput(input: string, tokens: readonly string[]): string {
  if (!input) return input;
  let out = input;
  for (const token of tokens) {
    if (!token) continue;
    // Split-join is a literal replace (no regex escaping).
    out = out.split(token).join('***REDACTED***');
  }
  return out;
}

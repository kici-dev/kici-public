/**
 * Apply private-npm-registry auth to a workflow's `.kici/.npmrc` for the
 * lifetime of one `npm install` invocation, then restore the file on cleanup.
 *
 * Why a closure-cleanup pattern (mirrors `setupSshAuth.cleanup()` in
 * `packages/agent/src/checkout/git-clone.ts`): the customer's committed
 * `.kici/.npmrc` may carry literal `${VAR}` placeholders or an unrelated
 * scope mapping. We must NOT clobber it permanently — we just want to
 * append the agent-managed registry/auth lines for this single install,
 * then revert.
 *
 * Token bytes never end up in the on-disk `.npmrc`. Each registry's token
 * is exposed as a job-scoped env var (`KICI_NPM_TOKEN_${jobIdShort}_<i>`)
 * and the on-disk auth line carries the env var reference (`${VAR}`). npm
 * substitutes at read time. The job-scoped nonce makes the env var name
 * unguessable from outside the install subprocess.
 *
 * Merge order: customer-committed `.npmrc` lines come FIRST, agent-generated
 * lines come LAST. npm's last-wins semantics make the agent's line shadow
 * any literal `_authToken=...` the customer accidentally committed for a
 * registry KiCI manages — refuses to let a committed secret beat a managed
 * one.
 *
 * `installEnvSecrets` is a separate channel for customers who prefer the
 * "commit a `.kici/.npmrc` with `${MY_TOKEN}` and supply MY_TOKEN as a
 * scoped secret" pattern (Option C in the design doc). Each entry becomes
 * an env var on the install subprocess; the customer's existing `.npmrc`
 * uses it as `${MY_TOKEN}`.
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
  /** Resolved registries from the orchestrator. Empty/undefined = no-op. */
  npmRegistries: readonly NpmRegistrySpec[] | undefined;
  /** Bare-name resolved secrets to project as install env vars. */
  installEnvSecrets: Record<string, string> | undefined;
  /** Short (8 char) job-scoped nonce — used as suffix on synthesized env-var names. */
  jobIdShort: string;
}

export interface ApplyNpmRegistryConfigResult {
  /** Env vars to merge into the install subprocess (token vars + installEnvSecrets). */
  extraEnv: Record<string, string>;
  /** Token bytes the caller MUST mask out of stdout/stderr before logging. */
  tokensForRedaction: string[];
  /** Restore `.kici/.npmrc` to its pre-call state. Idempotent; never throws. */
  cleanup: () => Promise<void>;
}

/** No-op result returned when nothing needs to be applied. */
function noopResult(): ApplyNpmRegistryConfigResult {
  return {
    extraEnv: {},
    tokensForRedaction: [],
    cleanup: async () => {},
  };
}

/** Build the synthesized env-var name for registry index `i`. */
function tokenEnvName(jobIdShort: string, index: number): string {
  return `KICI_NPM_TOKEN_${jobIdShort}_${index}`;
}

/** Render the agent-managed block of `.npmrc` lines. */
function renderAgentLines(registries: readonly NpmRegistrySpec[], jobIdShort: string): string {
  if (registries.length === 0) return '';
  const lines: string[] = [];
  for (let i = 0; i < registries.length; i++) {
    const reg = registries[i];
    const envVar = tokenEnvName(jobIdShort, i);
    // Strip the URL's protocol; npm's auth-token line uses `//host/path/`
    // (RFC 3986 authority + path, sans scheme). Both http and https map to
    // the same `//host/` form so an http-toggled registry still authenticates.
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

/** Read original `.npmrc` bytes; null if the file does not exist. */
async function readOriginalNpmrc(npmrcPath: string): Promise<string | null> {
  try {
    return await readFile(npmrcPath, 'utf8');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return null;
    throw err;
  }
}

/**
 * Apply the merged `.npmrc` and return env + redaction + cleanup. Caller
 * runs the npm install with `extraEnv` merged in, then awaits cleanup()
 * inside the install's `finally`.
 */
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

  // Build the synthesized token env vars. Use a job-scoped nonce so the var
  // name is unguessable from outside this install subprocess.
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

/** Mask every token in `tokensForRedaction` out of `input` before logging. */
export function redactNpmOutput(input: string, tokens: readonly string[]): string {
  if (!input) return input;
  let out = input;
  for (const token of tokens) {
    if (!token) continue;
    // Split-join is a literal replace (no regex escaping required).
    out = out.split(token).join('***REDACTED***');
  }
  return out;
}

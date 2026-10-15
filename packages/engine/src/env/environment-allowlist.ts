/**
 * Environment variable filtering shared by the orchestrator bare-metal backend
 * (spawned agent processes) and agent sandbox execution (customer code), so
 * orchestrator/agent secrets (DATABASE_URL, GITHUB_PRIVATE_KEY, PLATFORM_TOKEN,
 * WEBHOOK_SECRET, etc.) never reach child processes or customer code.
 */

/**
 * System environment variables that are safe to pass into spawned processes.
 * Anything NOT listed is stripped, so new host variables never leak downstream.
 */
export const ALLOWED_SYSTEM_VARS = [
  'PATH',
  'HOME',
  'USER',
  'SHELL',
  'LANG',
  'LC_ALL',
  'TERM',
  'TMPDIR',
  'NODE_PATH',
  'TZ',
  // Windows-essential, none carrying credentials. Without PATHEXT the OS cannot
  // resolve a bare command name (e.g. `jq`) to its `.exe`, so a step fails with
  // "not recognized" even when the tool's directory is on PATH. Most Windows
  // tooling needs the rest (temp dirs, profile/appdata, the command interpreter).
  'PATHEXT',
  'SystemRoot',
  'windir',
  'COMSPEC',
  'TEMP',
  'TMP',
  'USERPROFILE',
  'LOCALAPPDATA',
  'APPDATA',
  'PROCESSOR_ARCHITECTURE',
  'NUMBER_OF_PROCESSORS',
] as const;

/**
 * Default environment variables injected into every sandbox execution, set
 * before user/secret env vars so those can override them.
 * - FORCE_COLOR=1: color-aware libraries (chalk, etc.) emit ANSI codes even
 *   when stdout is a pipe, so the dashboard log viewer shows color.
 */
export const SANDBOX_DEFAULT_VARS: Record<string, string> = {
  FORCE_COLOR: '1',
};

/**
 * KICI environment variables required by the agent. The scaler sets them
 * explicitly rather than copying the orchestrator's process.env.
 */
export const AGENT_REQUIRED_KICI_VARS = [
  'KICI_ORCHESTRATOR_URL',
  'KICI_AGENT_ID',
  'KICI_LABELS',
  'KICI_MAX_CONCURRENT_JOBS',
  'KICI_SCALER_MANAGED',
  'KICI_EXECUTION_MODE',
  'KICI_PORT',
] as const;

/**
 * Prefix for operator-defined orchestrator env vars forwarded to spawned agent
 * processes with the prefix stripped. For example:
 *   KICI_AGENT_ENV_HTTP_PROXY=http://proxy:3128
 *   -> HTTP_PROXY=http://proxy:3128 in the agent process
 */
export const KICI_AGENT_ENV_PREFIX = 'KICI_AGENT_ENV_' as const;

/**
 * Non-`KICI_` agent/orchestrator infrastructure secrets, scrubbed from a
 * trusted-env passthrough alongside the whole `KICI_*` namespace, so even a
 * trusted fleet agent never leaks control-plane credentials into a step.
 */
export const TRUSTED_ENV_SCRUB_EXACT = [
  'DATABASE_URL',
  'PLATFORM_TOKEN',
  'WEBHOOK_SECRET',
  'GITHUB_PRIVATE_KEY',
] as const;

/**
 * Whether a variable must NEVER reach a workflow step, even under the
 * trusted-env profile: the whole `KICI_*` namespace (orchestrator URL, agent
 * token, secret key, bootstrap admin token, scaler internals, identity) plus
 * the denylist above. "Trusted" means "host env yes, the agent's KiCI identity no".
 */
export function isTrustedEnvScrubbed(key: string): boolean {
  return key.startsWith('KICI_') || (TRUSTED_ENV_SCRUB_EXACT as readonly string[]).includes(key);
}

/**
 * Build the trusted-env passthrough set: every defined entry of `source` whose
 * key `isTrustedEnvScrubbed` does not scrub. Both env-narrowing layers (scaler →
 * agent process, agent → step) use it under the trusted-env profile.
 */
export function buildTrustedPassthroughEnv(
  source: Record<string, string | undefined>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(source)) {
    if (value !== undefined && !isTrustedEnvScrubbed(key)) out[key] = value;
  }
  return out;
}

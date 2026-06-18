/**
 * Shared environment allowlist constants for KiCI.
 *
 * Single source of truth for environment variable filtering used across tiers:
 * - Orchestrator bare-metal backend (spawned agent processes)
 * - Agent sandbox execution (customer code isolation)
 *
 * These constants ensure that orchestrator/agent secrets (DATABASE_URL,
 * GITHUB_PRIVATE_KEY, PLATFORM_TOKEN, WEBHOOK_SECRET, etc.) are never leaked
 * to child processes or customer code.
 */

/**
 * System environment variables that are safe to pass into spawned processes.
 *
 * This is an explicit allowlist -- anything NOT listed here is stripped.
 * Adding new variables to the host process will NOT leak them downstream.
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
  // Windows-essential system variables. Without PATHEXT the OS cannot resolve
  // a bare command name (e.g. `jq`) to its `.exe`, so a step that runs an
  // installed tool by name fails with "not recognized" even when the tool's
  // directory is on PATH. The rest are needed by most Windows tooling
  // (temp dirs, profile/appdata locations, the command interpreter). None of
  // these carry credentials — the allowlist's job is to keep KICI_* /
  // DATABASE_URL / PLATFORM_TOKEN out, which these are not.
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
 * Default environment variables injected into every sandbox execution.
 *
 * These are set before user/secret env vars so they can be overridden.
 * - FORCE_COLOR=1: Ensures color-aware libraries (chalk, etc.) emit ANSI
 *   codes even when stdout is a pipe (non-TTY). Without this, log output
 *   appears uncolored in the dashboard log viewer.
 */
export const SANDBOX_DEFAULT_VARS: Record<string, string> = {
  FORCE_COLOR: '1',
};

/**
 * KICI environment variables required by the agent.
 *
 * These are set explicitly by the scaler (not copied from orchestrator process.env)
 * to ensure the agent receives only the values it needs with correct content.
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
 * Prefix for operator-defined environment variables that should be forwarded
 * from the orchestrator process to spawned agent processes.
 *
 * Variables with this prefix in the orchestrator's process.env are forwarded
 * to agent child processes with the prefix stripped. For example:
 *   KICI_AGENT_ENV_HTTP_PROXY=http://proxy:3128
 *   -> HTTP_PROXY=http://proxy:3128 in the agent process
 */
export const KICI_AGENT_ENV_PREFIX = 'KICI_AGENT_ENV_' as const;

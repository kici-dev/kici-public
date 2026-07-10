/**
 * Environment sanitization for sandbox execution.
 *
 * Uses an explicit allowlist approach: only known-safe system variables are
 * copied from the host process.env. Agent-internal credentials (KICI_*,
 * DATABASE_URL, PLATFORM_TOKEN, WEBHOOK_SECRET, etc.) are NEVER included.
 *
 * 7-layer merge precedence (later overrides earlier):
 *   1. Allowed system vars from process.env
 *   2. Sandbox defaults (FORCE_COLOR=1, etc.)
 *   3. KICI_* system vars (orchestrator-generated, from userEnv)
 *   4. Org-level environment vars (from orchestrator via contextVars)
 *   5. Source-level environment overrides (merged into contextVars by orchestrator)
 *   6. Job env (from lock file env field, evaluated by orchestrator)
 *   7. setEnv() calls (runtime -- applied at step execution, not here)
 */

import {
  ALLOWED_SYSTEM_VARS,
  SANDBOX_DEFAULT_VARS,
  buildTrustedPassthroughEnv,
} from '@kici-dev/engine';

/**
 * Build a sanitized environment for sandbox execution.
 *
 * Constructs an environment from scratch using the 7-layer merge:
 * 1. Explicitly allowed system variables from process.env
 * 2. Sandbox default variables (FORCE_COLOR, etc.)
 * 3. User-defined env vars (KICI_* system vars from orchestrator)
 * 4-5. Environment vars (org-level + source overrides, pre-merged by orchestrator)
 * 6. Job env (SDK-defined, evaluated by orchestrator)
 * 7. setEnv() calls (runtime -- not handled here)
 *
 * Secrets are NOT injected into environment variables by this function.
 * They flow through IPC to ctx.secrets and are only exposed via ctx.secrets.expose().
 *
 * Agent-internal credentials (KICI_ORCHESTRATOR_URL, DATABASE_URL,
 * PLATFORM_TOKEN, WEBHOOK_SECRET, etc.) are never included because they
 * are not in the allowlist.
 *
 * The `trustedEnv` option (default false) selects the trusted fleet-agent
 * profile: Layer 1 passes the ambient host env through instead of restricting
 * to `ALLOWED_SYSTEM_VARS`, minus the agent's own KiCI identity/operational
 * secrets (the whole `KICI_*` namespace + a small non-`KICI_` infra denylist).
 * It is read ONLY from agent config (`KICI_TRUSTED_ENV`), never from a dispatch
 * payload, so a workflow cannot request it. With it OFF the output is
 * byte-identical to the allowlist-only behavior.
 *
 * @param userEnv - Environment variables from workflow config and orchestrator
 * @param options - Optional extended options for environment layers
 * @returns A new Record with only safe environment variables
 */
export function buildSanitizedEnv(
  userEnv: Record<string, string>,
  options?: {
    contextVars?: Record<string, string>;
    jobEnv?: Record<string, string>;
    trustedEnv?: boolean;
  },
): Record<string, string> {
  const sanitized: Record<string, string> = {};

  // Layer 1: system vars. Default profile copies only the explicit allowlist;
  // the trusted profile passes the ambient host env through minus the scrub-list.
  if (options?.trustedEnv) {
    Object.assign(sanitized, buildTrustedPassthroughEnv(process.env));
  } else {
    for (const key of ALLOWED_SYSTEM_VARS) {
      const value = process.env[key];
      if (value !== undefined) {
        sanitized[key] = value;
      }
    }
  }

  // Layer 2: Apply sandbox defaults (FORCE_COLOR=1, etc.)
  Object.assign(sanitized, SANDBOX_DEFAULT_VARS);

  // Layer 3: Merge user-defined env vars (KICI_* from orchestrator)
  Object.assign(sanitized, userEnv);

  // Layers 4-5: Environment vars (org-level + source overrides, pre-merged by orchestrator)
  if (options?.contextVars) {
    Object.assign(sanitized, options.contextVars);
  }

  // Layer 6: Job env (SDK-defined env field from lock file)
  if (options?.jobEnv) {
    Object.assign(sanitized, options.jobEnv);
  }

  // Layer 7: setEnv() -- applied at runtime, not here

  return sanitized;
}

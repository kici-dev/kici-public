/**
 * Environment sanitization for sandbox execution. Only allowlisted system
 * variables are copied from the host process.env, so agent-internal
 * credentials (KICI_*, DATABASE_URL, PLATFORM_TOKEN, WEBHOOK_SECRET, etc.) are
 * never included.
 *
 * Merge precedence (later overrides earlier):
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
 * Build a sanitized environment from scratch with the layered merge above.
 *
 * Secrets are not injected as env vars: they flow through IPC to ctx.secrets
 * and are exposed only via ctx.secrets.expose().
 *
 * `trustedEnv` (default false) selects the trusted fleet-agent profile: layer 1
 * passes the ambient host env through instead of only `ALLOWED_SYSTEM_VARS`,
 * minus the agent's own identity/operational secrets (the whole `KICI_*`
 * namespace + a small non-`KICI_` infra denylist). It comes only from agent
 * config (`KICI_TRUSTED_ENV`), never a dispatch payload, so a workflow cannot
 * request it.
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

  // Layer 1.
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

  // Layer 2.
  Object.assign(sanitized, SANDBOX_DEFAULT_VARS);

  // Layer 3.
  Object.assign(sanitized, userEnv);

  // Layers 4-5, pre-merged by the orchestrator.
  if (options?.contextVars) {
    Object.assign(sanitized, options.contextVars);
  }

  // Layer 6.
  if (options?.jobEnv) {
    Object.assign(sanitized, options.jobEnv);
  }

  return sanitized;
}

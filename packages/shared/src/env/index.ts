/**
 * Env schema helpers for services. Deliberately NOT re-exported from the
 * package root: it pulls Zod and only Node-side config loaders use it.
 */

export {
  defineEnv,
  validateUnknownKiciVars,
  RESERVED_NON_SCHEMA_KICI_VARS,
  RESERVED_NON_SCHEMA_KICI_PREFIXES,
  type DefineEnvOptions,
  type DefineEnvResult,
  type EnvFieldSpec,
  type EnvMap,
  type EnvMapValue,
  type ValidateUnknownKiciVarsOptions,
} from './define-env.js';

export { LoggerEnvSchema, LOGGER_ENV_VARS, LOGGER_ENV_FIELD_SPECS } from './logger-env.js';

export { ORCHESTRATOR_DEFAULT_PORT, AGENT_DEFAULT_PORT } from './default-ports.js';

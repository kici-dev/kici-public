/**
 * @kici-dev/shared/env — env schema helpers shared across services.
 *
 * Subpath export so server-side packages can `import { defineEnv } from
 * '@kici-dev/shared/env'`. This subpath is intentionally NOT re-exported
 * from the package root: it pulls Zod and is only meaningful in Node-side
 * config loaders, not from browser code.
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

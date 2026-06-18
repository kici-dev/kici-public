/**
 * Shared LoggerEnv schema.
 *
 * The logger (packages/shared/src/logger.ts) reads these env vars *before*
 * the per-service config loads, so we can't include them in the service
 * schemas the normal way. We still want them in `docs/operator/env-reference.md`
 * and in `validateUnknownKiciVars()`'s known-var set, so this schema documents
 * them in one place. Each service includes the keys here when computing its
 * "known KICI_* vars" list, and the docs generator emits a "Logger / shared"
 * section from this schema.
 *
 * IMPORTANT: do not change the runtime behaviour of `logger.ts` from this
 * schema — the schema is documentation + the unknown-var allowlist, not the
 * source of truth for the logger.
 */

import { z } from 'zod';
import type { EnvFieldSpec } from './define-env.js';

export const LoggerEnvSchema = z.object({
  KICI_LOG_DIR: z.string().optional(),
  KICI_LOG_MAX_SIZE: z.string().default('500m'),
  KICI_LOG_RETENTION_DAYS: z.coerce.number().default(7),
  /**
   * Output format selection: `auto` (default — JSON when stdout is piped,
   * plain text when stdout is a TTY), `plain` (always pretty), or `json`
   * (always structured). Runtime services pin this to `json` so a stray
   * journal-attached PTY can never flip them into plain mode.
   */
  KICI_LOG_FORMAT: z.enum(['auto', 'plain', 'json']).default('auto'),
  /** Set by the orchestrator process; used as a filename suffix. */
  KICI_CLUSTER_INSTANCE_ID: z.string().optional(),
  /** Set by the agent process; used as a filename suffix. */
  KICI_AGENT_ID: z.string().optional(),
  /** Set by the platform process; used as a filename suffix. */
  KICI_PLATFORM_INSTANCE_ID: z.string().optional(),
});

/** All env vars the logger reads, for the unknown-KICI-var scanner. */
export const LOGGER_ENV_VARS = [
  'KICI_LOG_DIR',
  'KICI_LOG_MAX_SIZE',
  'KICI_LOG_RETENTION_DAYS',
  'KICI_LOG_FORMAT',
  'KICI_CLUSTER_INSTANCE_ID',
  'KICI_AGENT_ID',
  'KICI_PLATFORM_INSTANCE_ID',
] as const;

/** Doc-friendly description map (consumed by the env-reference generator). */
export const LOGGER_ENV_FIELD_SPECS: EnvFieldSpec[] = [
  {
    envVar: 'KICI_CLUSTER_INSTANCE_ID',
    aliases: [],
    fieldPath: 'KICI_CLUSTER_INSTANCE_ID',
    required: false,
    type: 'string',
    description:
      'Stable orchestrator identifier; appended to the log filename so multiple instances can share one KICI_LOG_DIR.',
  },
  {
    envVar: 'KICI_AGENT_ID',
    aliases: [],
    fieldPath: 'KICI_AGENT_ID',
    required: false,
    type: 'string',
    description:
      'Stable agent identifier; appended to the agent log filename so multiple agents can share one KICI_LOG_DIR.',
  },
  {
    envVar: 'KICI_LOG_DIR',
    aliases: [],
    fieldPath: 'KICI_LOG_DIR',
    required: false,
    type: 'string',
    description:
      'Directory for rotated JSON log files. When unset, the logger only writes to stdout/stderr.',
  },
  {
    envVar: 'KICI_LOG_FORMAT',
    aliases: [],
    fieldPath: 'KICI_LOG_FORMAT',
    required: false,
    defaultValue: '"auto"',
    type: 'enum:auto|plain|json',
    description:
      'Output format for stdout/stderr. `auto` (default) emits JSON when stdout is piped and plain coloured text when stdout is a TTY. `plain` and `json` force the corresponding format regardless of TTY. Runtime services (orchestrator, agent, platform, dashboard SSR) pin `json` so a journal-attached PTY cannot flip them into plain mode.',
  },
  {
    envVar: 'KICI_LOG_MAX_SIZE',
    aliases: [],
    fieldPath: 'KICI_LOG_MAX_SIZE',
    required: false,
    defaultValue: '"500m"',
    type: 'string',
    description:
      'Per-file size cap for rotated logs. Accepts a numeric byte count or a size suffix (`k`, `m`, `g`).',
  },
  {
    envVar: 'KICI_LOG_RETENTION_DAYS',
    aliases: [],
    fieldPath: 'KICI_LOG_RETENTION_DAYS',
    required: false,
    defaultValue: '7',
    type: 'number',
    description: 'How many days of rotated logs to keep before deletion.',
  },
  {
    envVar: 'KICI_PLATFORM_INSTANCE_ID',
    aliases: [],
    fieldPath: 'KICI_PLATFORM_INSTANCE_ID',
    required: false,
    type: 'string',
    description:
      'Stable Platform identifier; appended to the platform log filename so multiple instances can share one KICI_LOG_DIR.',
  },
];

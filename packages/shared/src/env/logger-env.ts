/**
 * Env vars read before per-service config loads (by `logger.ts`, and by
 * `kiciTmpBase()` for `KICI_TMPDIR`), so they cannot live in the service
 * schemas. This schema feeds each service's known-KICI_* list and the
 * "Logger / shared" section of `docs/operator/env-reference.md`.
 *
 * IMPORTANT: this schema is documentation + the unknown-var allowlist, not the
 * logger's source of truth; it does not change `logger.ts` runtime behaviour.
 */

import { z } from 'zod';
import type { EnvFieldSpec } from './define-env.js';

export const LoggerEnvSchema = z.object({
  KICI_LOG_DIR: z.string().optional(),
  KICI_LOG_MAX_SIZE: z.string().default('500m'),
  KICI_LOG_RETENTION_DAYS: z.coerce.number().default(7),
  /** Runtime services pin `json` so a journal-attached PTY cannot flip them to plain. */
  KICI_LOG_FORMAT: z.enum(['auto', 'plain', 'json']).default('auto'),
  /** Set by the orchestrator process; used as a filename suffix. */
  KICI_CLUSTER_INSTANCE_ID: z.string().optional(),
  /** Set by the agent process; used as a filename suffix. */
  KICI_AGENT_ID: z.string().optional(),
  /** Set by the platform process; used as a filename suffix. */
  KICI_PLATFORM_INSTANCE_ID: z.string().optional(),
  /** Read by `kiciTmpBase()` before any service config loads. */
  KICI_TMPDIR: z.string().optional(),
  /** Read by `@kici-dev/shared/load-service-env-file` before any config loads. */
  KICI_ENV_FILE: z.string().optional(),
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
  'KICI_TMPDIR',
  'KICI_ENV_FILE',
] as const;

/** Consumed by the env-reference generator. */
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
    envVar: 'KICI_ENV_FILE',
    aliases: [],
    fieldPath: 'KICI_ENV_FILE',
    required: false,
    type: 'string',
    description:
      'Path of an env file the orchestrator or agent loads when it starts, before it reads any other setting. The Windows service installer sets it, so the service registration carries the path and not the values. Each `KEY=value` line overrides the inherited value, and `PATH` lines go in front of the inherited PATH. The process removes the variable once the file is loaded. On Windows, when the file sets a variable that Node.js reads only as it starts, such as `NODE_OPTIONS` or `NODE_EXTRA_CA_CERTS`, the process starts again with the loaded environment.',
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
  {
    envVar: 'KICI_TMPDIR',
    aliases: [],
    fieldPath: 'KICI_TMPDIR',
    required: false,
    type: 'string',
    description:
      'Base directory for KiCI-created temporary files (repo clones, build scratch, deploy render dirs). Defaults to the operating system temp directory. Set it to a path on a volume with free space when the default temp filesystem is small.',
  },
];

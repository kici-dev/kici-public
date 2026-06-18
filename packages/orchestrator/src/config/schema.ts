/**
 * Zod schemas for orchestrator configuration validation.
 *
 * Provides separate schemas for:
 * - localConfigSchema: validates YAML structure for per-orchestrator settings
 * - sharedConfigSchema: validates shared config stored in PostgreSQL
 * - appConfigSchema: validates the final merged config with cross-field validation
 *
 * Provider configuration (GitHub Apps, etc.) is managed via the `sources` table
 * and PgSecretStore, not through config schemas.
 */

import { randomUUID } from 'node:crypto';
import { z } from 'zod';

/**
 * Schema for the local YAML configuration file.
 * All fields optional except database.url.
 */
export const localConfigSchema = z.object({
  database: z.object({
    url: z.string().min(1, 'database.url is required'),
  }),
  instance: z
    .object({
      id: z.string().optional(),
      mode: z.enum(['platform', 'hybrid', 'independent']).optional(),
    })
    .optional(),
  server: z
    .object({
      port: z.coerce.number().optional(),
      basePath: z.string().optional(),
      logLevel: z.enum(['debug', 'info', 'warn', 'error']).optional(),
      tlsCertPath: z.string().optional(),
    })
    .optional(),
  scaler: z
    .object({
      configPath: z.string().optional(),
      configDir: z.string().optional(),
    })
    .optional(),
});

export type LocalConfigSchemaType = z.infer<typeof localConfigSchema>;

/**
 * Schema for the shared configuration stored in PostgreSQL.
 * All top-level fields are optional (DB may have partial config).
 */
export const sharedConfigSchema = z.object({
  platform: z
    .object({
      url: z.string().optional(),
      token: z.string().optional(),
    })
    .optional(),
  storage: z
    .object({
      type: z.enum(['s3']).optional(),
      bucket: z.string().optional(),
      prefix: z.string().optional(),
      region: z.string().optional(),
      endpoint: z.string().optional(),
      externalEndpoint: z.string().optional(),
      forcePathStyle: z.boolean().optional(),
      logBucket: z.string().optional(),
    })
    .optional(),
  agentAuth: z.enum(['token', 'none']).optional(),
  agentTokenTtlMs: z.coerce.number().optional(),
  rosterGraceMs: z.coerce.number().optional(),
  rosterTtlMs: z.coerce.number().optional(),
  queue: z
    .object({
      maxDepth: z.coerce.number().optional(),
      timeoutMs: z.coerce.number().optional(),
      /**
       * Pending-depth threshold that triggers the operator-facing backpressure
       * warning. `0` disables the warner (metrics still exported).
       */
      backpressureThreshold: z.coerce.number().optional(),
    })
    .optional(),
  lockfileCache: z
    .object({
      max: z.coerce.number().optional(),
      ttlMs: z.coerce.number().optional(),
    })
    .optional(),
  staleDetector: z
    .object({
      scanIntervalMs: z.coerce.number().optional(),
      thresholdMultiplier: z.coerce.number().optional(),
      heartbeatIntervalMs: z.coerce.number().optional(),
    })
    .optional(),
  secrets: z
    .object({
      key: z.string().optional(),
      keyFile: z.string().optional(),
      bootstrapAdminToken: z.string().optional(),
    })
    .optional(),
  pgCustomerSecrets: z
    .boolean()
    .default(true)
    .describe(
      'Allow dashboard users to create PG-stored secrets. Does not affect internal/operational secrets.',
    ),
  cluster: z
    .object({
      joinToken: z.string().optional(),
      raftElectionTimeoutMinMs: z.coerce.number().optional(),
      raftElectionTimeoutMaxMs: z.coerce.number().optional(),
      raftHeartbeatMs: z.coerce.number().optional(),
      peerHeartbeatIntervalMs: z.coerce.number().optional(),
      peerMaxReconnectDelayMs: z.coerce.number().optional(),
      role: z.enum(['coordinator', 'worker']).optional(),
      coordinatorUrl: z.string().optional(),
      peerStaleTimeoutMs: z.coerce.number().optional(),
    })
    .optional(),
  webhookPayloadDir: z.string().optional(),
  cacheTtlDays: z.coerce.number().optional(),
  cacheBuildTimeoutMs: z.coerce.number().optional(),
  cacheMaxTarballBytes: z.coerce.number().optional(),
  userCacheQuotaBytes: z.coerce.number().optional(),
  userCacheTtlMs: z.coerce.number().optional(),
  eventRouter: z
    .object({
      maxChainDepth: z.coerce.number().optional(),
      rateLimitPerWorkflowPerMinute: z.coerce.number().optional(),
      eventTtlSeconds: z.coerce.number().optional(),
      cleanupIntervalMs: z.coerce.number().optional(),
    })
    .optional(),
  eventLog: z
    .object({
      maxPayloadBytes: z.coerce.number().optional(),
    })
    .optional(),
});

export type SharedConfigSchemaType = z.infer<typeof sharedConfigSchema>;

/**
 * Schema for the final merged application configuration.
 * Includes cross-field validation via superRefine.
 */
export const appConfigSchema = z
  .object({
    instanceId: z.string().default(() => randomUUID()),
    mode: z.enum(['platform', 'hybrid', 'independent']).default('platform'),

    // From LocalConfig
    databaseUrl: z.string().default(''),
    port: z.coerce.number().default(4000),
    basePath: z.string().default('/'),
    tlsCertPath: z.string().optional(),
    scalerConfigPath: z.string().optional(),
    scalerConfigDir: z.string().optional(),

    // From SharedConfig
    platformUrl: z.string().optional(),
    platformToken: z.string().optional(),
    storage: z
      .object({
        type: z.enum(['s3']).optional(),
        bucket: z.string().optional(),
        prefix: z.string().optional(),
        region: z.string().optional(),
        endpoint: z.string().optional(),
        externalEndpoint: z.string().optional(),
        forcePathStyle: z.boolean().optional(),
        logBucket: z.string().optional(),
      })
      .optional(),
    agentAuth: z.enum(['token', 'none']).default('token'),
    agentTokenTtlMs: z.coerce.number().default(3_600_000),
    rosterGraceMs: z.coerce.number().default(300_000),
    rosterTtlMs: z.coerce.number().default(1_800_000),
    queueMaxDepth: z.coerce.number().default(1000),
    queueTimeoutMs: z.coerce.number().default(3_600_000),
    /**
     * Operator-facing backpressure warning threshold. See `configSchema` in
     * `packages/orchestrator/src/config.ts` for the user-facing prose.
     */
    queueBackpressureThreshold: z.coerce.number().default(100),
    lockfileCacheMax: z.coerce.number().default(500),
    lockfileCacheTtlMs: z.coerce.number().default(3_600_000),
    staleDetectorScanIntervalMs: z.coerce.number().default(60_000),
    staleDetectorThresholdMultiplier: z.coerce.number().default(2),
    jobHeartbeatIntervalMs: z.coerce.number().default(60_000),
    secretKey: z.string().optional(),
    secretKeyFile: z.string().optional(),
    bootstrapAdminToken: z.string().optional(),
    pgCustomerSecrets: z
      .boolean()
      .default(true)
      .describe(
        'Allow dashboard users to create PG-stored secrets. Does not affect internal/operational secrets.',
      ),
    cluster: z
      .object({
        instanceId: z
          .string()
          .optional()
          .default(() => randomUUID()),
        address: z.string().optional(),
        joinToken: z.string().optional(),
        credentialFile: z.string().default('~/.kici/peer-credential'),
        autoRotateCredentials: z.boolean().default(false),
        peers: z
          .union([
            z.array(z.string()),
            z.string().transform((v) => (v ? v.split(',').map((s) => s.trim()) : [])),
          ])
          .default([]),
        raftElectionTimeoutMinMs: z.coerce.number().default(5000),
        raftElectionTimeoutMaxMs: z.coerce.number().default(10000),
        raftHeartbeatMs: z.coerce.number().default(2000),
        peerHeartbeatIntervalMs: z.coerce.number().default(30000),
        peerMaxReconnectDelayMs: z.coerce.number().default(60000),
        /** Cluster role: coordinator (full orchestrator) or worker (delegated execution). */
        role: z.enum(['coordinator', 'worker']).default('coordinator'),
        /** URL of the coordinator to connect to when role=worker. */
        coordinatorUrl: z.string().optional(),
        /** Stale peer timeout in ms. */
        peerStaleTimeoutMs: z.coerce.number().default(60_000),
      })
      .prefault({}),
    webhookPayloadDir: z.string().optional(),
    cacheTtlDays: z.coerce.number().default(30),
    cacheBuildTimeoutMs: z.coerce.number().default(600_000),
    cacheMaxTarballBytes: z.coerce.number().default(524_288_000),
    userCacheQuotaBytes: z.coerce.number().default(5 * 1024 * 1024 * 1024),
    userCacheTtlMs: z.coerce.number().default(7 * 24 * 60 * 60 * 1000),
    eventRouterMaxChainDepth: z.coerce.number().default(10),
    eventRouterRateLimitPerWorkflowPerMinute: z.coerce.number().default(100),
    eventRouterEventTtlSeconds: z.coerce.number().default(604_800),
    eventRouterCleanupIntervalMs: z.coerce.number().default(3_600_000),
    /** Inbound webhook delivery log (event_log table). Soft-cap: oversized
     *  payloads are still recorded with `payload_omitted=true` so operators
     *  see the row -- they're not 413'd. Default 5 MB. */
    eventLogMaxPayloadBytes: z.coerce.number().default(5 * 1024 * 1024),
    logLevel: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
    nodeEnv: z.enum(['development', 'production', 'test']).default('development'),
  })
  .superRefine((data, ctx) => {
    const isWorker = data.cluster.role === 'worker';

    // Workers require a coordinator URL
    if (isWorker && !data.cluster.coordinatorUrl) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'cluster.coordinatorUrl is required when cluster.role=worker',
        path: ['cluster', 'coordinatorUrl'],
      });
    }

    // KICI_DATABASE_URL is required for coordinator mode (workers don't need it)
    if (!isWorker && !data.databaseUrl) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'databaseUrl is required for coordinator mode',
        path: ['databaseUrl'],
      });
    }

    // Platform/hybrid modes require relay connection (skip for workers)
    if (!isWorker && (data.mode === 'platform' || data.mode === 'hybrid')) {
      if (!data.platformUrl) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'platformUrl is required when mode is platform or hybrid',
          path: ['platformUrl'],
        });
      }
      if (!data.platformToken) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'platformToken is required when mode is platform or hybrid',
          path: ['platformToken'],
        });
      }
    }

    // Cluster: address required when peers are configured
    const peers = Array.isArray(data.cluster.peers) ? data.cluster.peers : [];
    if (peers.length > 0 && !data.cluster.address) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          'cluster.address is required when cluster.peers is set (peers need to know where to connect back)',
        path: ['cluster', 'address'],
      });
    }

    // Storage: S3 type requires bucket
    if (data.storage?.type === 's3' && !data.storage?.bucket) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'storage.bucket is required when storage.type is s3',
        path: ['storage', 'bucket'],
      });
    }
  });

export type AppConfigSchemaType = z.infer<typeof appConfigSchema>;

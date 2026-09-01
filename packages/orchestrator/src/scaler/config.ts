/**
 * YAML configuration loading and Zod validation for the scaler module.
 *
 * Handles:
 * - Main YAML config file parsing
 * - scalers.d/ directory merging (alphabetically sorted)
 * - Zod schema validation with type-specific refinements
 * - Memory string parsing (e.g., "2g" -> bytes)
 */

import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import {
  KNOWN_ROLES,
  ScalerBackendType,
  derivePlatformTaints,
  platformToTaints,
  scalerPlatformSchema,
} from '@kici-dev/engine';
import { ImagePullPolicy } from './types.js';
import type { ScalerConfig } from './types.js';

/**
 * Default cap on concurrent `backend.spawn` operations per backend when a
 * scaler entry does not set `maxConcurrentSpawns`. Bounds the provisioning rate
 * (image pull + create + start) so a burst of queued jobs cannot storm the
 * container socket / registry.
 */
export const DEFAULT_MAX_CONCURRENT_SPAWNS = 8;

/**
 * Zod schema for a single resource spec (cpus + memory).
 *
 * The flat shape used to be the public scaler config form (`{ cpus, memory }`).
 * It's still accepted at the label-set / defaults level via `resourceRequestSchema`
 * below, where it's normalized to the nested `{ requests, limits }` form.
 */
const resourceSpecSchema = z
  .object({
    memory: z.string().optional(),
    cpus: z.number().positive().max(256).optional(),
  })
  .strict();

/**
 * Zod schema for nested-form `ResourceRequest` (`{ requests, limits }`).
 */
const nestedResourceRequestSchema = z
  .object({
    requests: resourceSpecSchema.optional(),
    limits: resourceSpecSchema.optional(),
  })
  .strict();

/**
 * Resource request schema accepted at the label-set / defaults level.
 *
 * Two input forms:
 * - Nested (preferred): `{ requests?: {cpus, memory}, limits?: {cpus, memory} }`.
 * - Flat shorthand: `{ cpus, memory }` -- treated as `limits`, `requests` mirrored from it.
 *
 * Always normalizes to the nested form so downstream code sees one shape.
 */
const resourceRequestSchema = z.union([nestedResourceRequestSchema, resourceSpecSchema]).transform(
  (
    value,
  ): {
    requests?: { cpus?: number; memory?: string };
    limits?: { cpus?: number; memory?: string };
  } => {
    // Flat form: treat as `limits`, mirror to `requests`.
    if ('cpus' in value || 'memory' in value) {
      const flat = value as { cpus?: number; memory?: string };
      if (flat.cpus === undefined && flat.memory === undefined) return {};
      return { requests: { ...flat }, limits: { ...flat } };
    }
    return value as {
      requests?: { cpus?: number; memory?: string };
      limits?: { cpus?: number; memory?: string };
    };
  },
);

/**
 * Zod schema for an aggregate resource cap (per-scaler / per-orchestrator / per-machine).
 *
 * `maxMemory` is parsed at config-load to bytes, exposed downstream as
 * `maxMemoryBytes` so the scaler doesn't re-parse on every spawn check.
 */
const resourceCapSchema = z
  .object({
    maxCpu: z.number().positive().optional(),
    maxMemory: z.string().optional(),
  })
  .strict()
  .transform((value, ctx) => {
    let maxMemoryBytes: number | undefined;
    if (value.maxMemory !== undefined) {
      try {
        maxMemoryBytes = parseMemoryString(value.maxMemory);
      } catch (err) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: err instanceof Error ? err.message : String(err),
          path: ['maxMemory'],
        });
        return z.NEVER;
      }
    }
    return { maxCpu: value.maxCpu, maxMemoryBytes };
  });

/**
 * Zod schema for warm pool configuration.
 */
const warmPoolSchema = z
  .object({
    enabled: z.boolean().default(false),
    size: z.number().int().nonnegative().default(0),
    idleTimeoutSeconds: z.number().default(300),
  })
  .optional();

/**
 * Zod schema for network policy configuration on a label set.
 * Controls RFC1918 and internet access for spawned agents.
 */
export const networkPolicySchema = z
  .object({
    /** Allow traffic to these CIDR ranges (exceptions to default RFC1918 block) */
    allowlist: z.array(z.string()).optional(),
    /** Block all outbound traffic except allowlisted ranges */
    denyAll: z.boolean().default(false),
  })
  .optional();

/**
 * Zod schema for a label-set configuration entry.
 */
export const labelSetConfigSchema = z
  .object({
    labels: z
      .array(z.string())
      .min(1)
      .refine((labels) => !labels.some((l) => l.toLowerCase().startsWith('kici:')), {
        message: "Labels with 'kici:' prefix are reserved and cannot be used in scaler labelSets",
      }),
    image: z.string().optional(),
    // Default IfNotPresent: KiCI agent images are pinned + immutable, so
    // re-pulling on every spawn only storms the registry/socket. A label set on
    // a moving tag opts into `Always` explicitly.
    imagePullPolicy: ImagePullPolicy.default(ImagePullPolicy.enum.IfNotPresent),
    binaryPath: z.string().optional(),
    /**
     * Per-label-set resource request and limit. Accepts either the nested
     * form `{ requests, limits }` or the legacy flat `{ cpus, memory }`
     * (treated as `limits`, with `requests` mirrored). Always normalized to nested.
     */
    resources: resourceRequestSchema.optional(),
    volumes: z.array(z.string()).optional(),
    containerSocket: z.boolean().default(false),
    env: z.record(z.string(), z.string()).optional(),

    // Backpressure mode for agent log streaming
    backpressureMode: z.enum(['pause', 'drop']).optional(),

    // Network isolation policy
    networkPolicy: networkPolicySchema,

    // Firecracker-specific label-set overrides
    rootfsPath: z.string().optional(),
    kernelPath: z.string().optional(),
    vcpuCount: z.number().int().positive().optional(),
    memSizeMib: z.number().int().positive().optional(),
    overlayDriveSizeMib: z.number().int().positive().optional(),
  })
  .strict();

/**
 * Zod schema for a single scaler entry.
 * Includes type-specific refinements:
 * - Docker scalers require 'image' on every label set
 * - Bare-metal scalers require 'binaryPath' on every label set
 */
const scalerEntrySchema = z
  .object({
    name: z.string(),
    type: ScalerBackendType.exclude(['kubernetes']),
    maxAgents: z.number().int().positive(),
    // Provisioning-rate throttle: at most this many `backend.spawn` operations
    // (image pull + create + start) run concurrently per backend. Orthogonal to
    // `maxAgents` (the population cap) — a burst of in-cap jobs still spawns all
    // of them, just this many at a time, so it does not storm the socket.
    maxConcurrentSpawns: z.number().int().positive().default(DEFAULT_MAX_CONCURRENT_SPAWNS),
    labelSets: z.array(labelSetConfigSchema).min(1),
    host: z.string().optional(),
    socketPath: z.string().optional(),
    runtime: z.enum(['docker', 'podman', 'auto']).default('auto'),
    orchestratorUrl: z.string().optional(),
    extraHosts: z.array(z.string()).optional(),
    networkIsolation: z.boolean().default(true),
    warmPool: warmPoolSchema,

    /**
     * Labels a job MUST declare in `runsOn` to allocate on this scaler.
     *
     * Mirrors the Kubernetes "taints" concept: if a scaler has
     * `mandatoryLabels: ['gpu']`, a job's `runsOn` must include `gpu` for
     * the scaler to be considered. Generic jobs that don't list every
     * mandatory label are blocked from this scaler entirely, even if
     * their other labels are a subset of one of the scaler's labelSets.
     *
     * The `kici:` prefix is reserved for auto-injected system labels
     * (kici:role:*, kici:os:*, kici:arch:*, kici:agent:*, kici:scaler:*)
     * and cannot be used here — same as `labelSets[].labels`.
     *
     * Default: `[]` (no gating; behavior is unchanged from before this feature).
     */
    mandatoryLabels: z
      .array(z.string())
      .default([])
      .refine((labels) => !labels.some((l) => l.toLowerCase().startsWith('kici:')), {
        message: "Labels with 'kici:' prefix are reserved and cannot be used in mandatoryLabels",
      }),

    /**
     * Structured platform of this pool's agents. When set, the auto-injected
     * `kici:os:*` / `kici:arch:*` labels AND the mandatory platform taint both
     * derive from this single field — a non-default `os` (`macos`, `windows`)
     * or `arch` (`arm64`) taints the pool so only jobs that request it are
     * routed here. Optional: when omitted, bare-metal pools derive the platform
     * from the host OS/arch, and container / firecracker pools default to linux.
     */
    platform: scalerPlatformSchema.optional(),

    roles: z
      .array(z.enum([...KNOWN_ROLES, 'all']))
      .optional()
      .transform((roles) => {
        if (!roles) return undefined; // undefined = all
        if (roles.includes('all')) return undefined; // normalize to all
        if (roles.length === 0) return []; // empty = execution only
        return roles.filter((r) => r !== 'all') as string[];
      }),

    // Resource caps + machine-pool reference (cap math wired in scaler manager)
    resourceCap: resourceCapSchema.optional(),
    machinePool: z.string().optional(),
    enforceCgroups: z.boolean().default(false),

    // Firecracker-specific scaler-level fields
    firecrackerPath: z.string().optional(),
    jailerPath: z.string().optional(),
    kernelPath: z.string().optional(),
    chrootBaseDir: z.string().default('/srv/jailer'),
    uid: z.number().int().optional(),
    gid: z.number().int().optional(),
    vcpuCount: z.number().int().positive().default(2),
    memSizeMib: z.number().int().positive().default(512),
    /**
     * When the orchestrator runs as a non-root user (e.g. user-mode systemd on
     * an edge worker), set this to true so privileged commands (`ip`, `chown`)
     * are wrapped with `sudo -n`. Operators must have a NOPASSWD sudoers entry
     * for those binaries. On hosts where the orchestrator is already root,
     * leave unset.
     */
    requireSudo: z.boolean().default(false),

    // ── Event-backend fields (meaningful only when `type: 'event'`) ──
    /**
     * Workflow refs (e.g. `org/infra`) the reserved scale-up / scale-down
     * events are delivered to. The provisioning / teardown workflows subscribe
     * with `kiciEvent()` and drive an external cloud instance. Required for a
     * `type: event` scaler; ignored otherwise.
     */
    provisioningTargets: z.array(z.string().min(1)).optional(),
    /**
     * Seconds a pending provisioning claim code stays valid before it expires.
     * @default 300
     */
    claimTtlSeconds: z.number().int().positive().default(300),
    /**
     * Seconds the ephemeral agent token minted for a claimed provision stays
     * valid. @default 600
     */
    agentTokenTtlSeconds: z.number().int().positive().default(600),
  })
  .strict()
  .superRefine((data, ctx) => {
    if (data.type === ScalerBackendType.enum.event) {
      if (!data.provisioningTargets || data.provisioningTargets.length === 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Event scaler "${data.name}" requires a non-empty 'provisioningTargets' array (workflow refs the scale-up/scale-down events are delivered to)`,
          path: ['provisioningTargets'],
        });
      }
    }
    if (data.type === ScalerBackendType.enum.container) {
      data.labelSets.forEach((ls, i) => {
        if (!ls.image) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `Container scaler "${data.name}" label set [${i}] requires an 'image' field`,
            path: ['labelSets', i, 'image'],
          });
        }
      });
    }
    if (data.type === ScalerBackendType.enum['bare-metal']) {
      // A bare-metal label set names what to launch: a local binary, an agent
      // image, or both. `binaryPath` alone spawns a host process. `image`
      // alone is job-image mode — a job that names its own container image runs
      // IN that image with the KiCI runtime injected, which is the only thing
      // an image-and-no-binary set can mean. Both together spawn the process,
      // and the image is where that process materializes the runtime from when
      // it nests a job container. Requiring `binaryPath` unconditionally made
      // job-image mode unreachable: no validated config could express the shape
      // that selects it.
      data.labelSets.forEach((ls, i) => {
        if (!ls.binaryPath && !ls.image) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message:
              `Bare-metal scaler "${data.name}" label set [${i}] requires a 'binaryPath' ` +
              `(spawn a local agent process) or an 'image' (run the job's own container image ` +
              `as the agent, with the KiCI runtime injected)`,
            path: ['labelSets', i, 'binaryPath'],
          });
        }
      });
    }
    // Every label set's DERIVED gate must be reachable from that label set,
    // otherwise no job can route through it: the matcher demands every gate
    // label in the job's `runsOn`, and only labels the set actually matches on
    // can supply them. The gate is the configured `mandatoryLabels`, the
    // structured platform taints, and the legacy taints derived from the set's
    // own labels — the same three the manager unions per label set.
    //
    // The reachable set is the label set plus the structured platform taints,
    // which the manager injects into every label set as matchable labels. The
    // legacy taints derive from the set's own labels and so are always
    // reachable; only a configured label can be unreachable in practice, but
    // checking the whole derived gate is what keeps this validation and the
    // manager's gate the same rule.
    //
    // A bare-metal pool that declares no `platform` host-derives it at runtime,
    // which this validation deliberately does not do: a config's validity must
    // not depend on the machine loading it. Those taints are self-satisfying
    // anyway, since the same resolved platform supplies both the gate and the
    // injected label.
    const structuredTaints = data.platform ? platformToTaints(data.platform) : [];
    data.labelSets.forEach((ls, i) => {
      const gate = new Set([
        ...data.mandatoryLabels.map((l) => l.toLowerCase()),
        ...structuredTaints.map((l) => l.toLowerCase()),
        ...derivePlatformTaints(ls.labels),
      ]);
      if (gate.size === 0) return;
      const reachable = new Set([
        ...ls.labels.map((l) => l.toLowerCase()),
        ...structuredTaints.map((l) => l.toLowerCase()),
      ]);
      for (const required of gate) {
        if (!reachable.has(required)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `Scaler "${data.name}" gate label "${required}" is missing from labelSets[${i}].labels — every label in a label set's gate must be requestable on that label set, otherwise no job can route to it`,
            path: ['labelSets', i, 'labels'],
          });
        }
      }
    });
    if (data.type === ScalerBackendType.enum.firecracker) {
      // Scaler-level required fields
      if (!data.firecrackerPath) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Firecracker scaler "${data.name}" requires a 'firecrackerPath' field`,
          path: ['firecrackerPath'],
        });
      }
      if (!data.jailerPath) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Firecracker scaler "${data.name}" requires a 'jailerPath' field`,
          path: ['jailerPath'],
        });
      }
      if (!data.kernelPath) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Firecracker scaler "${data.name}" requires a 'kernelPath' field`,
          path: ['kernelPath'],
        });
      }
      if (data.uid === undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Firecracker scaler "${data.name}" requires a 'uid' field`,
          path: ['uid'],
        });
      }
      if (data.gid === undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Firecracker scaler "${data.name}" requires a 'gid' field`,
          path: ['gid'],
        });
      }
      // Per-label-set required fields
      data.labelSets.forEach((ls, i) => {
        if (!ls.rootfsPath) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `Firecracker scaler "${data.name}" label set [${i}] requires a 'rootfsPath' field`,
            path: ['labelSets', i, 'rootfsPath'],
          });
        }
      });
    }
  });

/**
 * Zod schema for Firecracker network configuration.
 * Global across all Firecracker scalers on the orchestrator.
 */
export const firecrackerNetworkSchema = z.object({
  cidr: z.string().default('10.0.0.0/24'),
  bridgeName: z.string().default('kici-br0'),
  gateway: z.string().default('10.0.0.1'),
  netmask: z.string().default('255.255.255.0'),
  /** nft table name for this coordinator's host bridge (disjoint per bridge). */
  table: z.string().default('kici'),
  /**
   * When true (default), the orchestrator verifies and provisions this host
   * bridge on startup (self-heal), so a fresh Firecracker host needs no manual
   * `kici-admin firecracker provision`. Set false to keep explicit operator
   * control of the host network (the CLI provision flow stays available).
   */
  autoProvisionHost: z.boolean().default(true),
});

/**
 * Zod schema for the complete scaler configuration file.
 * Validates version, global limits, defaults, and scaler entries.
 */
export const scalerFileSchema = z
  .object({
    version: z.literal(1),
    globalMaxAgents: z.number().int().positive().default(50),
    defaults: z
      .object({
        resources: resourceRequestSchema.optional(),
      })
      .optional(),
    /** Cap on summed `requests` across every agent this orchestrator is running. */
    globalResourceCap: resourceCapSchema.optional(),
    /** Named pools for cross-orchestrator coordination on the same host. */
    machinePools: z
      .array(
        z
          .object({
            name: z.string().min(1),
            cap: resourceCapSchema,
          })
          .strict(),
      )
      .optional(),
    scalers: z.array(scalerEntrySchema),
    firecracker: firecrackerNetworkSchema.optional(),
  })
  .superRefine((data, ctx) => {
    // Cross-validate: every `machinePool: 'foo'` reference must resolve.
    const poolNames = new Set((data.machinePools ?? []).map((p) => p.name));
    data.scalers.forEach((entry, i) => {
      if (entry.machinePool !== undefined && !poolNames.has(entry.machinePool)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Scaler "${entry.name}" references unknown machinePool "${entry.machinePool}". Define it under top-level machinePools[].`,
          path: ['scalers', i, 'machinePool'],
        });
      }
    });
    // Reject duplicate pool names (config error -- silent overwrite would mask intent).
    const seen = new Set<string>();
    (data.machinePools ?? []).forEach((p, i) => {
      if (seen.has(p.name)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Duplicate machinePool name "${p.name}".`,
          path: ['machinePools', i, 'name'],
        });
      }
      seen.add(p.name);
    });
  });

/**
 * Parse a memory string with unit suffix to bytes.
 *
 * Supported formats:
 * - "512m" or "512M" -> 536870912 (512 * 1024^2)
 * - "2g" or "2G" -> 2147483648 (2 * 1024^3)
 * - "1024k" or "1024K" -> 1048576 (1024 * 1024)
 *
 * @throws Error if the format is invalid
 */
export function parseMemoryString(memory: string): number {
  const match = memory.match(/^(\d+(?:\.\d+)?)\s*([kmgKMG])$/);
  if (!match) {
    throw new Error(
      `Invalid memory format: "${memory}". Expected format like "512m", "2g", or "1024k".`,
    );
  }

  const value = parseFloat(match[1]);
  const unit = match[2].toLowerCase();

  switch (unit) {
    case 'k':
      return Math.floor(value * 1024);
    case 'm':
      return Math.floor(value * 1024 * 1024);
    case 'g':
      return Math.floor(value * 1024 * 1024 * 1024);
    default:
      throw new Error(`Unknown memory unit: "${unit}"`);
  }
}

/**
 * Load and validate the scaler configuration from YAML files.
 *
 * 1. Reads the main config file
 * 2. If scalersDirPath provided, reads all *.yaml and *.yml files
 *    from the directory (sorted alphabetically) and merges their
 *    scalers arrays into the main config
 * 3. Validates the merged config through Zod schema
 *
 * @param configPath - Path to the main scaler YAML config file
 * @param scalersDirPath - Optional path to scalers.d/ directory for additional scaler definitions
 * @returns Validated ScalerConfig
 * @throws ZodError if validation fails
 */
export async function loadScalerConfig(
  configPath: string,
  scalersDirPath?: string,
): Promise<ScalerConfig> {
  // 1. Read main config
  const mainYaml = await readFile(configPath, 'utf-8');
  const mainConfig = parseYaml(mainYaml) as Record<string, unknown>;

  // 2. Read and merge scalers.d/ files
  if (scalersDirPath) {
    const files = await readdir(scalersDirPath);
    const yamlFiles = files.filter((f) => f.endsWith('.yaml') || f.endsWith('.yml')).sort();

    for (const file of yamlFiles) {
      const content = await readFile(join(scalersDirPath, file), 'utf-8');
      const parsed = parseYaml(content) as Record<string, unknown> | null;
      if (parsed?.scalers && Array.isArray(parsed.scalers)) {
        const existing = (mainConfig.scalers as unknown[]) ?? [];
        mainConfig.scalers = [...existing, ...parsed.scalers];
      }
    }
  }

  // 3. Validate through Zod
  return scalerFileSchema.parse(mainConfig) as ScalerConfig;
}

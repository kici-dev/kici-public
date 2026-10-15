/**
 * Scaler config loading: the main YAML file plus `scalers.d/` (merged in
 * alphabetical order), validated by Zod with type-specific refinements.
 */

import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import {
  KNOWN_ROLES,
  ScalerBackendType,
  canonicalizeLabels,
  platformToTaints,
  resourceRequestNestedSchema,
  scalerPlatformSchema,
} from '@kici-dev/engine';
import { ImagePullPolicy } from './types.js';
import { parseExtraHost } from './firecracker-extra-hosts.js';
import { agentLaunchRefusal } from './bare-metal-launch.js';
import type { ScalerConfig } from './types.js';
import { parseHostAccess } from '@kici-dev/shared/net';
import { toErrorMessage } from '@kici-dev/shared';

/**
 * Default per-backend `maxConcurrentSpawns`. Bounds the provisioning rate (image
 * pull + create + start) so a burst of queued jobs cannot storm the container
 * socket / registry.
 */
export const DEFAULT_MAX_CONCURRENT_SPAWNS = 8;

/**
 * Plain OS/arch labels an operator might write to mean "this pool is that
 * platform". The structured `platform` field is the only thing that taints a
 * pool, so a label set naming one of these without it is refused.
 */
const PLAIN_PLATFORM_LABELS = new Set<string>([
  'windows',
  'win32',
  'macos',
  'darwin',
  'arm64',
  'aarch64',
  'arm',
]);

/**
 * `{ requests?: {cpus, memory}, limits?: {cpus, memory} }`, at the label-set /
 * defaults level. A flat `{ cpus, memory }` is refused with a message naming the
 * nested form.
 */
const resourceRequestSchema = z.preprocess((value, ctx) => {
  if (value && typeof value === 'object' && ('cpus' in value || 'memory' in value)) {
    ctx.addIssue({
      code: 'custom',
      message:
        'resources takes { requests, limits }: nest cpus and memory under limits (a limit alone also sets the request)',
    });
    return z.NEVER;
  }
  return value;
}, resourceRequestNestedSchema);

/**
 * Aggregate resource cap (per-scaler / per-orchestrator / per-machine).
 * `maxMemory` is parsed once at load into `maxMemoryBytes`, not on every spawn check.
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

const warmPoolSchema = z
  .object({
    enabled: z.boolean().default(false),
    size: z.number().int().nonnegative().default(0),
    idleTimeoutSeconds: z.number().default(300),
  })
  .optional();

/**
 * A label set's RFC1918 and internet access for spawned agents.
 */
export const networkPolicySchema = z
  .object({
    /** Allow traffic to these CIDR ranges (exceptions to default RFC1918 block) */
    allowlist: z.array(z.string()).optional(),
    /** Block all outbound traffic except allowlisted ranges */
    denyAll: z.boolean().default(false),
    /**
     * What the sandbox may reach on the orchestrator's own host, as
     * `<cidr|address|*>[:<port|*>]` entries. Setting it replaces the class
     * default outright; an empty array denies every host service.
     */
    hostAccess: z
      .array(z.string())
      .optional()
      .superRefine((entries, ctx) => {
        for (const entry of entries ?? []) {
          try {
            parseHostAccess(entry);
          } catch (err) {
            ctx.addIssue({ code: 'custom', message: toErrorMessage(err) });
          }
        }
      }),
  })
  .optional();

export const labelSetConfigSchema = z
  .object({
    labels: z
      .array(z.string())
      .min(1)
      .refine((labels) => !labels.some((l) => l.toLowerCase().startsWith('kici:')), {
        message: "Labels with 'kici:' prefix are reserved and cannot be used in scaler labelSets",
      })
      // Config load is an ingress into the matching domain, so the fold happens
      // here: a pool declaring `Docker` must reach a `runsOn: ['docker']` job,
      // and these labels flow verbatim into the agent's KICI_LABELS.
      .transform((labels) => canonicalizeLabels(labels)),
    image: z.string().optional(),
    // Default IfNotPresent: KiCI agent images are pinned + immutable, so a
    // per-spawn pull only storms the registry/socket. A moving tag opts into `Always`.
    imagePullPolicy: ImagePullPolicy.default(ImagePullPolicy.enum.IfNotPresent),
    binaryPath: z.string().optional(),
    /** Per-label-set resource request and limit (`{ requests, limits }`). */
    resources: resourceRequestSchema.optional(),
    volumes: z.array(z.string()).optional(),
    containerSocket: z.boolean().default(false),
    env: z.record(z.string(), z.string()).optional(),

    // Agent log streaming backpressure.
    backpressureMode: z.enum(['pause', 'drop']).optional(),

    networkPolicy: networkPolicySchema,

    // Firecracker-only overrides
    rootfsPath: z.string().optional(),
    kernelPath: z.string().optional(),
    vcpuCount: z.number().int().positive().optional(),
    memSizeMib: z.number().int().positive().optional(),
    overlayDriveSizeMib: z.number().int().positive().optional(),
  })
  .strict();

/**
 * Type-specific refinements:
 * - Docker scalers require 'image' on every label set
 * - Bare-metal label sets name a `binaryPath` or an `image`; on a Windows host a
 *   batch-file `binaryPath` must be one cmd.exe can run
 */
const scalerEntrySchema = z
  .object({
    name: z.string(),
    type: ScalerBackendType.exclude(['kubernetes']),
    maxAgents: z.number().int().positive(),
    // Provisioning-rate throttle, per backend. Orthogonal to `maxAgents` (the
    // population cap): a burst of in-cap jobs still all spawn, this many at a time.
    maxConcurrentSpawns: z.number().int().positive().default(DEFAULT_MAX_CONCURRENT_SPAWNS),
    labelSets: z.array(labelSetConfigSchema).min(1),
    host: z.string().optional(),
    socketPath: z.string().optional(),
    runtime: z.enum(['docker', 'podman', 'auto']).default('auto'),
    orchestratorUrl: z.string().optional(),
    /**
     * Extra `host:address` name mappings for spawned agents. A container scaler,
     * and a bare-metal scaler's job-image agent containers, pass them to the
     * runtime; a Firecracker scaler writes them into each guest's `/etc/hosts`,
     * with `host-gateway` resolved to the bridge gateway. None by default.
     */
    extraHosts: z.array(z.string()).optional(),
    networkIsolation: z.boolean().default(true),
    warmPool: warmPoolSchema,

    /**
     * Labels a job MUST declare in `runsOn` to allocate on this scaler, like
     * Kubernetes taints: a job missing any of them is blocked from this scaler
     * even if its other labels are a subset of a label set.
     *
     * The `kici:` prefix is reserved for auto-injected system labels
     * (kici:role:*, kici:os:*, kici:arch:*, kici:agent:*, kici:scaler:*), as in
     * `labelSets[].labels`. Default: `[]` (no gating).
     */
    mandatoryLabels: z
      .array(z.string())
      .default([])
      .refine((labels) => !labels.some((l) => l.toLowerCase().startsWith('kici:')), {
        message: "Labels with 'kici:' prefix are reserved and cannot be used in mandatoryLabels",
      })
      // Folded at the same ingress as `labelSets[].labels` above, so the gate
      // and the sets it gates are compared in one case.
      .transform((labels) => canonicalizeLabels(labels)),

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

    // Cap math lives in the scaler manager.
    resourceCap: resourceCapSchema.optional(),
    machinePool: z.string().optional(),
    enforceCgroups: z.boolean().default(false),

    // Firecracker-only
    firecrackerPath: z.string().optional(),
    jailerPath: z.string().optional(),
    kernelPath: z.string().optional(),
    chrootBaseDir: z.string().default('/srv/jailer'),
    uid: z.number().int().optional(),
    gid: z.number().int().optional(),
    vcpuCount: z.number().int().positive().default(2),
    memSizeMib: z.number().int().positive().default(512),
    /**
     * For a non-root orchestrator (e.g. user-mode systemd on an edge worker),
     * wraps privileged commands in `sudo -n`: `ip`, `chown`, `chmod`, `kill` and
     * `nft` for a Firecracker scaler, `nft` for a bare-metal scaler's job-image
     * label sets. Operators need a NOPASSWD sudoers entry for those binaries.
     * Leave unset when the orchestrator is already root.
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
      // `binaryPath` alone spawns a host process. `image` alone is job-image
      // mode: a job naming its own container image runs IN it with the KiCI
      // runtime injected. Both spawn the process, which materializes the runtime
      // from the image when it nests a job container. Requiring `binaryPath`
      // always would make job-image mode unreachable by any valid config.
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
        // cmd.exe reads some path characters in a Windows batch-file path as
        // syntax; refusing here fails startup or reload, not every launch.
        const refusal = ls.binaryPath ? agentLaunchRefusal(ls.binaryPath, process.platform) : null;
        if (refusal) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `Bare-metal scaler "${data.name}" label set [${i}]: ${refusal}`,
            path: ['labelSets', i, 'binaryPath'],
          });
        }
      });
    }
    // Only the structured `platform` field taints a pool, so a plain platform
    // label without it would take every unqualified job: refused.
    if (!data.platform) {
      data.labelSets.forEach((ls, i) => {
        for (const label of ls.labels) {
          if (PLAIN_PLATFORM_LABELS.has(label.toLowerCase())) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              message: `Scaler "${data.name}" labelSets[${i}]: label "${label}" names a platform; declare platform: { os, arch } instead`,
              path: ['labelSets', i, 'labels'],
            });
          }
        }
      });
    }
    // Every gate label must be matchable on its label set, or no job can route
    // through it: the matcher demands every gate label in `runsOn`. The gate is
    // `mandatoryLabels` plus the platform taints (the manager's per-set union);
    // the reachable set is the labels plus the same taints, which the manager
    // injects into every label set.
    //
    // A bare-metal pool with no `platform` host-derives it at runtime; this
    // check does not, since config validity must not depend on the loading
    // machine. Those taints are self-satisfying anyway.
    const structuredTaints = data.platform ? platformToTaints(data.platform) : [];
    data.labelSets.forEach((ls, i) => {
      const gate = new Set([
        ...data.mandatoryLabels.map((l) => l.toLowerCase()),
        ...structuredTaints.map((l) => l.toLowerCase()),
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
      // The rootfs /init writes each entry into the guest's /etc/hosts, so a
      // malformed one fails here, at startup, not at spawn time.
      (data.extraHosts ?? []).forEach((entry, i) => {
        try {
          parseExtraHost(entry);
        } catch (err) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `Firecracker scaler "${data.name}" extraHosts[${i}]: ${toErrorMessage(err)}`,
            path: ['extraHosts', i],
          });
        }
      });
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
   * bridge on startup, so a fresh host needs no manual `kici-admin firecracker
   * provision`. False keeps operator control (the CLI flow stays available).
   */
  autoProvisionHost: z.boolean().default(true),
});

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
    // Duplicate pool names are refused: a silent overwrite would mask intent.
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
 * Parse a memory string to bytes, with binary units: "512m" -> 512 * 1024^2,
 * "2G" -> 2 * 1024^3, "1024k" -> 1024 * 1024 (suffix case-insensitive).
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
 * Load the main YAML config, append the `scalers` arrays of every `*.yaml` /
 * `*.yml` in `scalersDirPath` (alphabetical order), and validate the result.
 *
 * @throws ZodError if validation fails
 */
export async function loadScalerConfig(
  configPath: string,
  scalersDirPath?: string,
): Promise<ScalerConfig> {
  const mainYaml = await readFile(configPath, 'utf-8');
  const mainConfig = parseYaml(mainYaml) as Record<string, unknown>;

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

  return scalerFileSchema.parse(mainConfig) as ScalerConfig;
}

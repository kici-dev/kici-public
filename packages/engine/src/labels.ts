import { z } from 'zod';

/**
 * Structured auto-labels with category prefixes.
 *
 * Auto-labels are injected into agent label sets so that workflows can target
 * specific platforms, architectures, scaler types, hosts, etc. without
 * requiring manual label configuration.
 *
 * All auto-labels use the `kici:` namespace prefix to distinguish them from
 * user-defined labels. Users cannot set labels with this prefix.
 *
 * Categories:
 *   kici:os:      — operating system (kici:os:linux, kici:os:macos, kici:os:windows)
 *   kici:arch:    — CPU architecture (kici:arch:x64, kici:arch:amd64, kici:arch:arm64)
 *   kici:agent:   — scaler/execution backend type (kici:agent:container, kici:agent:bare-metal, kici:agent:firecracker)
 *   kici:scaler:  — scaler backend name (kici:scaler:stg-container, kici:scaler:prod-firecracker)
 *   kici:host:    — hostname of the machine running the agent (kici:host:<hostname>)
 *   kici:role:    — agent role (kici:role:builder, kici:role:init-runner)
 *
 * Platform mapping (os.platform() → kici:os: labels):
 *   'linux'  → ['kici:os:linux']
 *   'darwin' → ['kici:os:macos', 'kici:os:darwin']
 *   'win32'  → ['kici:os:windows', 'kici:os:win32']
 *
 * Architecture mapping (os.arch() → kici:arch: labels):
 *   'x64'   → ['kici:arch:x64', 'kici:arch:amd64']
 *   'arm64' → ['kici:arch:arm64']
 *   other   → ['kici:arch:{value}']
 */

/**
 * Derive kici:os: and kici:arch: labels from platform and architecture strings.
 */
export function deriveOsArchLabels(platform: string, arch: string): string[] {
  const labels: string[] = [];

  switch (platform) {
    case 'linux':
      labels.push('kici:os:linux');
      break;
    case 'darwin':
      labels.push('kici:os:macos', 'kici:os:darwin');
      break;
    case 'win32':
      labels.push('kici:os:windows', 'kici:os:win32');
      break;
    default:
      labels.push(`kici:os:${platform}`);
  }

  switch (arch) {
    case 'x64':
      labels.push('kici:arch:x64', 'kici:arch:amd64');
      break;
    case 'arm64':
      labels.push('kici:arch:arm64');
      break;
    default:
      labels.push(`kici:arch:${arch}`);
  }

  return labels;
}

/**
 * Plain OS/arch labels that gate a bare-metal scaler as a mandatory taint.
 * A pool whose declared labels include one of these only accepts jobs that
 * explicitly request that platform. Linux and x64/amd64 are the defaults and
 * are absent on purpose — an unqualified `runsOn: 'bare-metal'` job must still
 * land on a Linux-x64 scaler.
 */
export const PLATFORM_TAINT_LABELS = new Set<string>([
  'windows',
  'win32',
  'macos',
  'darwin',
  'arm64',
  'aarch64',
  'arm',
]);

/**
 * Intersect a pool's declared labels with {@link PLATFORM_TAINT_LABELS},
 * returning the de-duplicated plain platform-taint labels (lowercased) in
 * input order.
 */
export function derivePlatformTaints(declaredLabels: string[]): string[] {
  const seen = new Set<string>();
  for (const raw of declaredLabels) {
    const label = raw.toLowerCase();
    if (PLATFORM_TAINT_LABELS.has(label)) seen.add(label);
  }
  return [...seen];
}

/**
 * Operating systems a scaler pool can declare via the structured `platform`
 * field. `linux` is the default and carries no taint; `macos` / `windows` are
 * non-default and taint the pool.
 */
export const ScalerOs = z.enum(['linux', 'macos', 'windows']);
export type ScalerOs = z.infer<typeof ScalerOs>;

/**
 * CPU architectures a scaler pool can declare via the structured `platform`
 * field. `x64` is the default and carries no taint; `arm64` taints the pool.
 */
export const ScalerArch = z.enum(['x64', 'arm64']);
export type ScalerArch = z.infer<typeof ScalerArch>;

/**
 * Structured platform of a scaler pool: the single source of truth for both the
 * auto-injected `kici:os:*` / `kici:arch:*` labels and the mandatory platform
 * taint. Declaring it once removes the ambiguity of matching plain string
 * labels against a denylist.
 */
export const scalerPlatformSchema = z.object({ os: ScalerOs, arch: ScalerArch }).strict();
export type ScalerPlatform = z.infer<typeof scalerPlatformSchema>;

/** Map a structured `ScalerOs` back to the `os.platform()` string it represents. */
function scalerOsToNodePlatform(os: ScalerOs): string {
  switch (os) {
    case 'linux':
      return 'linux';
    case 'macos':
      return 'darwin';
    case 'windows':
      return 'win32';
  }
}

/**
 * Derive the `kici:os:*` / `kici:arch:*` labels for a declared structured
 * platform. Reuses {@link deriveOsArchLabels} so the label shape is identical to
 * the host-reported form (e.g. `windows` yields both `kici:os:windows` and
 * `kici:os:win32`).
 */
export function platformToOsArchLabels(platform: ScalerPlatform): string[] {
  return deriveOsArchLabels(scalerOsToNodePlatform(platform.os), platform.arch);
}

/**
 * Derive the plain platform-taint labels for a declared structured platform.
 * Returns the canonical tokens (`macos`, `windows`, `arm64`) that a job's
 * `runsOn` must include to allocate on the pool. The linux/x64 default carries
 * no taint. Unlike {@link derivePlatformTaints} (which intersects declared
 * labels against a denylist), this derives from the structured field, so a pool
 * labeled `windows-2022` still taints correctly.
 */
export function platformToTaints(platform: ScalerPlatform): string[] {
  const taints: string[] = [];
  if (platform.os === 'macos') taints.push('macos');
  else if (platform.os === 'windows') taints.push('windows');
  if (platform.arch === 'arm64') taints.push('arm64');
  return taints;
}

/** Map an `os.platform()` string to a `ScalerOs`, or null when unrecognised. */
export function nodePlatformToScalerOs(nodePlatform: string): ScalerOs | null {
  switch (nodePlatform) {
    case 'linux':
      return 'linux';
    case 'darwin':
      return 'macos';
    case 'win32':
      return 'windows';
    default:
      return null;
  }
}

/** Map an `os.arch()` string to a `ScalerArch`, or null when unrecognised. */
export function nodeArchToScalerArch(nodeArch: string): ScalerArch | null {
  switch (nodeArch) {
    case 'x64':
      return 'x64';
    case 'arm64':
      return 'arm64';
    default:
      return null;
  }
}

/**
 * Build a structured platform from the host's `os.platform()` / `os.arch()`.
 * Returns null when either component is not one of the supported enum values,
 * so a caller can fall back to the legacy host-label derivation for exotic
 * hosts.
 */
export function hostToScalerPlatform(
  nodePlatform: string,
  nodeArch: string,
): ScalerPlatform | null {
  const os = nodePlatformToScalerOs(nodePlatform);
  const arch = nodeArchToScalerArch(nodeArch);
  return os && arch ? { os, arch } : null;
}

/** Prefix for the agent self-reported hostname label. */
export const HOST_LABEL_PREFIX = 'kici:host:';

/**
 * Build a kici:host: label from a hostname.
 */
export function hostLabel(hostname: string): string {
  return `${HOST_LABEL_PREFIX}${hostname}`;
}

/**
 * Extract the hostname from a kici:host: label, or null if the label is not a
 * host label. Inverse of {@link hostLabel}.
 */
export function parseHostLabel(label: string): string | null {
  return label.startsWith(HOST_LABEL_PREFIX) ? label.slice(HOST_LABEL_PREFIX.length) : null;
}

/**
 * Build a kici:agent: label from the scaler backend type.
 */
export function agentTypeLabel(backendType: string): string {
  return `kici:agent:${backendType}`;
}

/**
 * Build a kici:scaler: label from the scaler backend name.
 */
export function scalerLabel(backendName: string): string {
  return `kici:scaler:${backendName}`;
}

/**
 * Merges explicit labels with auto-derived structured labels.
 * Deduplicates the result.
 */
export function mergeAutoLabels(labels: string[], autoLabels: string[]): string[] {
  return [...new Set([...labels, ...autoLabels])];
}

/**
 * Normalized runsOn result with labels and exclude arrays.
 */
export interface NormalizedRunsOn {
  labels: string[];
  exclude: string[];
}

/**
 * Normalize the polymorphic runsOn value into a consistent object form.
 * Accepts string, string[], or { labels, exclude? } object.
 */
export function normalizeRunsOn(
  runsOn: string | string[] | { labels: string | string[]; exclude?: string | string[] },
): NormalizedRunsOn {
  if (typeof runsOn === 'string') return { labels: [runsOn], exclude: [] };
  if (Array.isArray(runsOn)) return { labels: runsOn, exclude: [] };
  const labels = Array.isArray(runsOn.labels) ? runsOn.labels : [runsOn.labels];
  const exclude = runsOn.exclude
    ? Array.isArray(runsOn.exclude)
      ? runsOn.exclude
      : [runsOn.exclude]
    : [];
  return { labels, exclude };
}

// --- Role definitions and utilities ---

/**
 * Known agent roles that grant capabilities beyond basic execution.
 * - builder: can run __build__ jobs (dependency cache compilation)
 * - init-runner: can run __init__ jobs (workspace initialization)
 */
export const KNOWN_ROLES = ['builder', 'init-runner'] as const;

/** Agent role type derived from KNOWN_ROLES. */
export type AgentRole = (typeof KNOWN_ROLES)[number];

/** Reserved label prefix — labels starting with this are system-managed. */
export const RESERVED_LABEL_PREFIX = 'kici:';

/**
 * Capability label prefix — `kici:capability:<name>` grants an agent a
 * privileged capability beyond plain execution. Distinct from `kici:role:`
 * (which gates which internal job kinds an agent runs).
 */
export const CAPABILITY_LABEL_PREFIX = 'kici:capability:';

/** Build a `kici:capability:<name>` label. */
export function capabilityLabel(name: string): string {
  return `${CAPABILITY_LABEL_PREFIX}${name}`;
}

/**
 * The `ssh-transport` capability: an agent holding this may run the bootstrap
 * bring-up (`ctx.kici.bootstrap.ensureInitRunner` / `preBootSend`) — i.e. SSH
 * to a declared-but-un-agented host. The orchestrator refuses to run a
 * bring-up on an agent that lacks it. Prod-critical: such an agent custodies
 * the bootstrap SSH key.
 */
export const SSH_TRANSPORT_CAPABILITY = 'kici:capability:ssh-transport';

/**
 * The `kici:init` lifecycle label carried by a temporary init-runner agent
 * brought up on a fresh box for bootstrap. Marks it as ephemeral + privileged;
 * it dies on reboot and is reaped. Distinct from `kici:role:init-runner`
 * (which is the per-job `__init__` workspace-init capability — a different
 * concept entirely).
 */
export const INIT_LABEL = 'kici:init';

/**
 * The `kici:privileged:root` label a bootstrap init-runner carries — it runs
 * as root in the target's rescue env to partition / format / install.
 */
export const PRIVILEGED_ROOT_LABEL = 'kici:privileged:root';

/** Role label prefix — used to generate role-specific labels. */
export const ROLE_LABEL_PREFIX = 'kici:role:';

/**
 * Convert a role name to its corresponding label.
 */
export function roleToLabel(role: AgentRole): string {
  return `${ROLE_LABEL_PREFIX}${role}`;
}

/**
 * The label every pre-run evaluation job routes to.
 *
 * Exported because three dispatch sites and the global eval round all target
 * it, and each had spelled the string out. Derived from {@link roleToLabel} so
 * it cannot drift from the prefix or from `KNOWN_ROLES`.
 */
export const INIT_RUNNER_ROLE_LABEL = roleToLabel('init-runner');

/**
 * Resolve a roles configuration into role labels.
 *
 * - undefined → all roles (backward compat: existing agents get all capabilities)
 * - [] → no roles (execution-only agent)
 * - ['all'] → all roles (explicit opt-in to all)
 * - ['builder'] → specific role labels only
 */
export function resolveRoleLabels(roles: readonly string[] | undefined): string[] {
  if (roles === undefined) return KNOWN_ROLES.map(roleToLabel);
  if (roles.length === 0) return [];
  if (roles.includes('all')) return KNOWN_ROLES.map(roleToLabel);
  return (roles as readonly AgentRole[]).map(roleToLabel);
}

/**
 * The full label set a scaler injects into an agent it spawns: the base label
 * set plus the scaler-assigned `kici:agent:`, `kici:scaler:`, and `kici:role:`
 * labels. This is exactly what the scaler writes into `KICI_LABELS`, and it is
 * the set an ephemeral agent token must be bound to — the agent then adds only
 * the self-reported platform facts (`kici:os:`, `kici:arch:`, `kici:host:`) at
 * registration, which the orchestrator's register-time scope gate exempts (see
 * `isSelfReportedLabel`). Keep this aligned with the agent's wire-label
 * construction in `orchestrator-client.ts#sendAgentRegister`.
 */
export function scalerAgentLabels(
  labelSet: string[],
  backendType: string,
  backendName: string,
  roles: readonly string[] | undefined,
): string[] {
  return [
    ...labelSet,
    agentTypeLabel(backendType),
    scalerLabel(backendName),
    ...resolveRoleLabels(roles),
  ];
}

/**
 * Label-category prefixes the agent self-reports at registration from its own
 * host (operating system, CPU architecture, hostname). They are immutable
 * platform facts, not authorization grants, so the orchestrator's register-time
 * label-scope gate does not require an ephemeral token to be bound to them.
 */
export const SELF_REPORTED_LABEL_PREFIXES = ['kici:os:', 'kici:arch:', 'kici:host:'] as const;

/**
 * True if a label is a self-reported platform fact (os/arch/host) rather than a
 * scaler-assigned, authorization-bearing label. Used by the agent register-time
 * scope gate to avoid flagging the agent's own platform labels as "elevated".
 */
export function isSelfReportedLabel(label: string): boolean {
  return SELF_REPORTED_LABEL_PREFIXES.some((p) => label.startsWith(p));
}

/**
 * Validate that no labels use the reserved kici: prefix.
 * Throws if any reserved labels are found (case-insensitive check).
 */
export function validateNoReservedLabels(labels: string[], source: string): void {
  const reserved = labels.filter((l) => l.toLowerCase().startsWith(RESERVED_LABEL_PREFIX));
  if (reserved.length > 0) {
    throw new Error(
      `Labels with '${RESERVED_LABEL_PREFIX}' prefix are reserved and cannot be used in ${source}: ${reserved.join(', ')}`,
    );
  }
}

/**
 * Check if a label is an auto-generated system label (has the kici: prefix).
 */
export function isAutoLabel(label: string): boolean {
  return label.toLowerCase().startsWith(RESERVED_LABEL_PREFIX);
}

/**
 * Separate labels into user-defined and auto-generated (kici: prefixed) groups.
 */
export function separateLabels(labels: string[]): { userLabels: string[]; autoLabels: string[] } {
  const userLabels: string[] = [];
  const autoLabels: string[] = [];
  for (const label of labels) {
    if (isAutoLabel(label)) {
      autoLabels.push(label);
    } else {
      userLabels.push(label);
    }
  }
  return { userLabels, autoLabels };
}

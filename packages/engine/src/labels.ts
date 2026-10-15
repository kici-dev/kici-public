import { z } from 'zod';

/**
 * Structured auto-labels, injected into agent label sets so workflows can target
 * platforms, architectures, scaler types, hosts, etc. without manual label
 * configuration. All use the `kici:` prefix, which users cannot set.
 *
 * Categories:
 *   kici:os:      — operating system (kici:os:linux, kici:os:macos, kici:os:windows)
 *   kici:arch:    — CPU architecture (kici:arch:x64, kici:arch:amd64, kici:arch:arm64)
 *   kici:agent:   — scaler/execution backend type (kici:agent:container, kici:agent:bare-metal, kici:agent:firecracker)
 *   kici:scaler:  — scaler backend name (kici:scaler:linux-container, kici:scaler:prod-firecracker)
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
 * taint, instead of matching plain string labels against a denylist.
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
 * Derive the plain platform-taint tokens (`macos`, `windows`, `arm64`) a job's
 * `runsOn` must include to allocate on the pool. The linux/x64 default carries
 * no taint. Derived from the structured field, so a pool labeled
 * `windows-2022` still taints correctly.
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
 * Returns null when either is unsupported, so a caller can fall back to the
 * host-label derivation for exotic hosts.
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

/** Merge explicit labels with auto-derived structured labels, de-duplicated. */
export function mergeAutoLabels(labels: string[], autoLabels: string[]): string[] {
  return [...new Set([...labels, ...autoLabels])];
}

/** Normalized `runsOn`. */
export interface NormalizedRunsOn {
  labels: string[];
  exclude: string[];
}

/** Normalize the polymorphic `runsOn` value into its object form. */
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

export type AgentRole = (typeof KNOWN_ROLES)[number];

/** Reserved label prefix — labels starting with this are system-managed. */
export const RESERVED_LABEL_PREFIX = 'kici:';

/**
 * `kici:capability:<name>` grants an agent a privileged capability beyond plain
 * execution. Distinct from `kici:role:`, which gates the internal job kinds an
 * agent runs.
 */
export const CAPABILITY_LABEL_PREFIX = 'kici:capability:';

/** Build a `kici:capability:<name>` label. */
export function capabilityLabel(name: string): string {
  return `${CAPABILITY_LABEL_PREFIX}${name}`;
}

/**
 * The `ssh-transport` capability: only an agent holding it may run the bootstrap
 * bring-up (`ctx.kici.bootstrap.ensureInitRunner` / `preBootSend`), i.e. SSH to
 * a declared-but-un-agented host. Prod-critical: such an agent custodies the
 * bootstrap SSH key.
 */
export const SSH_TRANSPORT_CAPABILITY = 'kici:capability:ssh-transport';

/**
 * `kici:runtime:<name>` states something the AGENT discovered about its own host.
 *
 * Deliberately NOT `kici:capability:`, which grants a privilege and so stays
 * token-bound, never self-asserted. A runtime fact grants nothing: it reports
 * what the host can do, as `kici:os:` reports what it is, and is self-reported
 * because the scaler cannot predict it at token-mint time.
 */
export const RUNTIME_LABEL_PREFIX = 'kici:runtime:';

/** Build a `kici:runtime:<name>` label. */
export function runtimeLabel(name: string): string {
  return `${RUNTIME_LABEL_PREFIX}${name}`;
}

/**
 * Runtime facts an agent reports about its own host at registration.
 *
 * - `docker` / `podman` — that container runtime's socket answered, so the
 *   agent can nest a job container.
 * - `container-build` — a `docker` / `podman` CLI is on PATH, so the agent can
 *   build a job's image from a Dockerfile. A host reachable only through a
 *   mounted socket can RUN containers but not BUILD one: the build shells out
 *   to the CLI.
 * - `job-image` — the agent runs inside one job's own container image, started
 *   for that job, so the orchestrator gives it no other work (any other job
 *   would run in an image it never declared). It only restricts the agent
 *   reporting it, so taking it on the agent's word grants nothing.
 */
export const RuntimeFact = z.enum(['docker', 'podman', 'container-build', 'job-image']);
export type RuntimeFact = z.infer<typeof RuntimeFact>;

/** The label a job's `runsOn` names to require a host that can build an image. */
export const CONTAINER_BUILD_RUNTIME_LABEL = runtimeLabel(RuntimeFact.enum['container-build']);

/** The label an agent running inside a job's own image registers with. */
export const JOB_IMAGE_RUNTIME_LABEL = runtimeLabel(RuntimeFact.enum['job-image']);

/**
 * `kici:agent-feature:<name>` states a behaviour the agent BUILD implements.
 * Like `kici:runtime:`, it is a fact, not a privilege: it routes work that
 * depends on the behaviour to an agent that has it, and grants nothing.
 */
export const AGENT_FEATURE_LABEL_PREFIX = 'kici:agent-feature:';

/**
 * Behaviours an agent build reports at registration.
 *
 * - `global-eval-skips-result-aware` — the pre-run global eval round runs only
 *   the needs-free generators and skips every generator declared with `needs`.
 */
export const AgentFeature = z.enum(['global-eval-skips-result-aware']);
export type AgentFeature = z.infer<typeof AgentFeature>;

/** Build a `kici:agent-feature:<name>` label. */
export function agentFeatureLabel(feature: AgentFeature): string {
  return `${AGENT_FEATURE_LABEL_PREFIX}${feature}`;
}

/** The label a global eval round carries when it must skip result-aware generators. */
export const GLOBAL_EVAL_SKIPS_RESULT_AWARE_LABEL = agentFeatureLabel(
  AgentFeature.enum['global-eval-skips-result-aware'],
);

/**
 * Every agent-feature label this build implements: what the agent self-reports
 * at registration, and what a scaler adds to the label sets of the agents it
 * spawns so it matches the same jobs.
 */
export const AGENT_FEATURE_LABELS: readonly string[] = AgentFeature.options.map(agentFeatureLabel);

/**
 * The `kici:init` lifecycle label of a temporary init-runner agent brought up
 * on a fresh box for bootstrap: ephemeral + privileged, it dies on reboot and
 * is reaped. Unrelated to `kici:role:init-runner`, the per-job `__init__`
 * workspace-init capability.
 */
export const INIT_LABEL = 'kici:init';

/**
 * The `kici:privileged:root` label a bootstrap init-runner carries — it runs
 * as root in the target's rescue env to partition / format / install.
 */
export const PRIVILEGED_ROOT_LABEL = 'kici:privileged:root';

export const ROLE_LABEL_PREFIX = 'kici:role:';

/** Convert a role name to its label. */
export function roleToLabel(role: AgentRole): string {
  return `${ROLE_LABEL_PREFIX}${role}`;
}

/**
 * The label every pre-run evaluation job routes to, shared by the dispatch
 * sites and the global eval round. Derived from {@link roleToLabel} so it
 * cannot drift from the prefix or from `KNOWN_ROLES`.
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
 * set plus the scaler-assigned `kici:agent:`, `kici:scaler:`, `kici:role:`, and
 * platform-taint labels. This is exactly what the scaler writes into
 * `KICI_LABELS` and the set an ephemeral agent token must be bound to; the
 * agent adds only self-reported facts at registration, which the
 * orchestrator's register-time scope gate exempts (see `isSelfReportedLabel`).
 * Keep this aligned with `orchestrator-client.ts#sendAgentRegister`.
 *
 * `platformTaints` are the plain tokens (`windows`, `macos`, `arm64`) derived
 * from the pool's resolved platform. A taint is a routing GRANT the matcher
 * gates on, not a host fact, so the orchestrator binds it into the ephemeral
 * token here; making it self-reported would let any agent claim any platform
 * unchallenged. The caller must derive them from the same source the gate uses
 * (`ScalerManager.resolveScalerPlatform`), never a second derivation.
 *
 * The result is de-duplicated in first-seen order: a warm pool measures
 * readiness with a label set that already carries the taints, so it passes
 * them as both `labelSet` and `platformTaints`.
 */
export function scalerAgentLabels(
  labelSet: string[],
  backendType: string,
  backendName: string,
  roles: readonly string[] | undefined,
  platformTaints: readonly string[] = [],
): string[] {
  return [
    ...new Set([
      ...labelSet,
      agentTypeLabel(backendType),
      scalerLabel(backendName),
      ...resolveRoleLabels(roles),
      ...platformTaints,
    ]),
  ];
}

/**
 * Label-category prefixes the agent self-reports at registration from its own
 * host or build: operating system, CPU architecture, hostname, runtime facts
 * and agent features. They are facts, not authorization grants, so the
 * orchestrator's register-time label-scope gate does not require an ephemeral
 * token to be bound to them.
 *
 * Any agent can assert a prefix listed here unchallenged: correct for a fact,
 * WRONG for a privilege, which is why `kici:capability:` is absent.
 */
export const SELF_REPORTED_LABEL_PREFIXES = [
  'kici:os:',
  'kici:arch:',
  'kici:host:',
  // The scaler cannot know at token-mint time whether a host has a container
  // runtime or a build CLI; gating on an orchestrator-side probe strands
  // container jobs, so the agent's own discovery decides.
  RUNTIME_LABEL_PREFIX,
  // Asserting a feature only routes to the agent work it claims to handle.
  AGENT_FEATURE_LABEL_PREFIX,
] as const;

/**
 * True if a label carries a {@link SELF_REPORTED_LABEL_PREFIXES} prefix rather
 * than being scaler-assigned and authorization-bearing. The agent
 * register-time scope gate uses it to avoid flagging those labels as "elevated".
 */
export function isSelfReportedLabel(label: string): boolean {
  return SELF_REPORTED_LABEL_PREFIXES.some((p) => label.startsWith(p));
}

/** Throw if any label uses the reserved `kici:` prefix (case-insensitive). */
export function validateNoReservedLabels(labels: string[], source: string): void {
  const reserved = labels.filter((l) => l.toLowerCase().startsWith(RESERVED_LABEL_PREFIX));
  if (reserved.length > 0) {
    throw new Error(
      `Labels with '${RESERVED_LABEL_PREFIX}' prefix are reserved and cannot be used in ${source}: ${reserved.join(', ')}`,
    );
  }
}

/** Whether a label is an auto-generated system label (`kici:` prefix, case-insensitive). */
export function isAutoLabel(label: string): boolean {
  return label.toLowerCase().startsWith(RESERVED_LABEL_PREFIX);
}

/** Split labels into user-defined and auto-generated (`kici:`) groups. */
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

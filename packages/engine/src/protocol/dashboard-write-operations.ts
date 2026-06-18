/**
 * Registry of dashboard write operations governed by the per-orch
 * dashboard-write policy.
 *
 * Subpath export: consumers import from
 * `@kici-dev/engine/protocol/dashboard-write-operations`. The file is pure
 * Zod + plain TypeScript with no node built-ins, so it remains
 * browser-safe and is also imported directly by the dashboard SPA for
 * capability rendering.
 *
 * Three audiences read this registry:
 *   - Orchestrator: enforces the policy per operation in dashboard.* handlers.
 *   - Platform: gates HTTP routes that proxy to the orch.
 *   - Dashboard: renders per-control state (enabled / disabled / loading).
 *
 * Adding a new operation: append an entry to `DashboardWriteOperation`
 * (the Zod enum) and `DASHBOARD_WRITE_OPERATIONS` (the descriptor array).
 * The runtime build-time tests on the orchestrator and Platform sides
 * fail until at least one gate handler references the new operation.
 */
import { z } from 'zod';

export const DashboardWriteOperation = z.enum([
  // Secrets — plaintext values traverse Platform memory when policy is enabled.
  'secrets.set',
  'secrets.delete',
  'secrets.scope.create',
  'secrets.scope.rename',
  'secrets.scope.delete',
  // Variables — plaintext values traverse Platform memory when policy is enabled.
  'variables.set',
  'variables.delete',
  // Environments — definition CRUD; no plaintext.
  'environments.create',
  'environments.update',
  'environments.test_access.set',
  'environments.delete',
  // Bindings and per-source overrides — reshape the resolution tree; no plaintext.
  'environments.bindings.set',
  'environments.source_overrides.set',
  'environments.source_overrides.delete',
  // Held runs — release execution.
  'held_runs.approve',
  'held_runs.reject',
  // DLQ — replay or drop failed webhooks.
  'event_dlq.retry',
  'event_dlq.discard',
  // Registrations — DoS-shaped or destructive.
  'registration.disable',
  'registration.delete',
  // Orch topology — config that affects scaler / dispatch.
  'global_workflows.update',
  'backends.sync',
  'backends.sync_one',
  'backends.test',
]);

export type DashboardWriteOperation = z.infer<typeof DashboardWriteOperation>;

/** Stable list of every operation in enum-declaration order. */
export const DASHBOARD_WRITE_OPERATION_VALUES: readonly DashboardWriteOperation[] = Object.freeze([
  'secrets.set',
  'secrets.delete',
  'secrets.scope.create',
  'secrets.scope.rename',
  'secrets.scope.delete',
  'variables.set',
  'variables.delete',
  'environments.create',
  'environments.update',
  'environments.test_access.set',
  'environments.delete',
  'environments.bindings.set',
  'environments.source_overrides.set',
  'environments.source_overrides.delete',
  'held_runs.approve',
  'held_runs.reject',
  'event_dlq.retry',
  'event_dlq.discard',
  'registration.disable',
  'registration.delete',
  'global_workflows.update',
  'backends.sync',
  'backends.sync_one',
  'backends.test',
]);

export const DashboardWriteCategory = z.enum([
  'Secrets',
  'Variables',
  'Environments',
  'Bindings',
  'Held runs',
  'DLQ',
  'Registrations',
  'Topology',
]);
export type DashboardWriteCategory = z.infer<typeof DashboardWriteCategory>;

export const DashboardWriteSensitivity = z.enum(['plaintext', 'authority', 'dispatch']);
export type DashboardWriteSensitivity = z.infer<typeof DashboardWriteSensitivity>;

/**
 * Descriptor for one dashboard write operation. The fields that don't
 * affect enforcement (label, cliEquivalent) are read by the dashboard
 * SPA to render policy-aware UI and by the docs generator.
 */
export interface DashboardWriteOperationDescriptor {
  /** The operation enum value used by enforcement helpers. */
  readonly name: DashboardWriteOperation;
  /** The wire message type the operation maps to (dashboard.* on Platform→Orch). */
  readonly wireMessageType: string;
  /** Grouping for UI rendering. */
  readonly category: DashboardWriteCategory;
  /** Human-facing label for tooltips and the Security policy page. */
  readonly label: string;
  /** Threat-model bucket — used by docs + the --sensitivity CLI sugar. */
  readonly sensitivity: DashboardWriteSensitivity;
  /** kici-admin invocation hint shown in the CLI snippet copied from the UI. */
  readonly cliEquivalent: string;
}

export const DASHBOARD_WRITE_OPERATIONS: readonly DashboardWriteOperationDescriptor[] =
  Object.freeze([
    {
      name: 'secrets.set',
      wireMessageType: 'dashboard.environments.secrets.set',
      category: 'Secrets',
      label: 'Set secret value',
      sensitivity: 'plaintext',
      cliEquivalent: 'kici-admin secret set',
    },
    {
      name: 'secrets.delete',
      wireMessageType: 'dashboard.environments.secrets.delete',
      category: 'Secrets',
      label: 'Delete secret',
      sensitivity: 'authority',
      cliEquivalent: 'kici-admin secret delete',
    },
    {
      name: 'secrets.scope.create',
      wireMessageType: 'dashboard.environments.secrets.scope.create',
      category: 'Secrets',
      label: 'Create secret scope',
      sensitivity: 'authority',
      cliEquivalent: 'kici-admin secret scope create',
    },
    {
      name: 'secrets.scope.rename',
      wireMessageType: 'dashboard.environments.secrets.scope.rename',
      category: 'Secrets',
      label: 'Rename secret scope',
      sensitivity: 'authority',
      cliEquivalent: 'kici-admin secret scope rename',
    },
    {
      name: 'secrets.scope.delete',
      wireMessageType: 'dashboard.environments.secrets.scope.delete',
      category: 'Secrets',
      label: 'Delete secret scope',
      sensitivity: 'authority',
      cliEquivalent: 'kici-admin secret scope delete',
    },
    {
      name: 'variables.set',
      wireMessageType: 'dashboard.environments.variables.set',
      category: 'Variables',
      label: 'Set variable value',
      sensitivity: 'plaintext',
      cliEquivalent: 'kici-admin variable set',
    },
    {
      name: 'variables.delete',
      wireMessageType: 'dashboard.environments.variables.delete',
      category: 'Variables',
      label: 'Delete variable',
      sensitivity: 'authority',
      cliEquivalent: 'kici-admin variable delete',
    },
    {
      name: 'environments.create',
      wireMessageType: 'dashboard.environments.create',
      category: 'Environments',
      label: 'Create environment',
      sensitivity: 'authority',
      cliEquivalent: 'kici-admin environment create',
    },
    {
      name: 'environments.update',
      wireMessageType: 'dashboard.environments.update',
      category: 'Environments',
      label: 'Update environment',
      sensitivity: 'authority',
      cliEquivalent: 'kici-admin environment set-policy',
    },
    {
      name: 'environments.test_access.set',
      wireMessageType: 'dashboard.environments.test_access.set',
      category: 'Environments',
      label: 'Set environment test access',
      sensitivity: 'authority',
      cliEquivalent: 'kici-admin environment set-policy --allow-local-execution',
    },
    {
      name: 'environments.delete',
      wireMessageType: 'dashboard.environments.delete',
      category: 'Environments',
      label: 'Delete environment',
      sensitivity: 'authority',
      cliEquivalent: 'kici-admin environment delete',
    },
    {
      name: 'environments.bindings.set',
      wireMessageType: 'dashboard.environments.bindings.set',
      category: 'Bindings',
      label: 'Set environment binding',
      sensitivity: 'authority',
      cliEquivalent: 'kici-admin environment bind',
    },
    {
      name: 'environments.source_overrides.set',
      wireMessageType: 'dashboard.environments.source-overrides.set',
      category: 'Bindings',
      label: 'Set source override',
      sensitivity: 'authority',
      cliEquivalent: 'kici-admin environment source-override set',
    },
    {
      name: 'environments.source_overrides.delete',
      wireMessageType: 'dashboard.environments.source-overrides.delete',
      category: 'Bindings',
      label: 'Delete source override',
      sensitivity: 'authority',
      cliEquivalent: 'kici-admin environment source-override delete',
    },
    {
      name: 'held_runs.approve',
      wireMessageType: 'dashboard.held-runs.approve',
      category: 'Held runs',
      label: 'Approve held run',
      sensitivity: 'dispatch',
      cliEquivalent: 'kici-admin runs approve',
    },
    {
      name: 'held_runs.reject',
      wireMessageType: 'dashboard.held-runs.reject',
      category: 'Held runs',
      label: 'Reject held run',
      sensitivity: 'dispatch',
      cliEquivalent: 'kici-admin runs reject',
    },
    {
      name: 'event_dlq.retry',
      wireMessageType: 'dashboard.event-dlq.retry',
      category: 'DLQ',
      label: 'Retry dead-lettered webhook',
      sensitivity: 'dispatch',
      cliEquivalent: 'kici-admin event-dlq retry',
    },
    {
      name: 'event_dlq.discard',
      wireMessageType: 'dashboard.event-dlq.discard',
      category: 'DLQ',
      label: 'Discard dead-lettered webhook',
      sensitivity: 'dispatch',
      cliEquivalent: 'kici-admin event-dlq discard',
    },
    {
      name: 'registration.disable',
      wireMessageType: 'dashboard.registration.disable',
      category: 'Registrations',
      label: 'Disable workflow registration',
      sensitivity: 'dispatch',
      cliEquivalent: 'kici-admin registration disable',
    },
    {
      name: 'registration.delete',
      wireMessageType: 'dashboard.registration.delete',
      category: 'Registrations',
      label: 'Delete workflow registration',
      sensitivity: 'dispatch',
      cliEquivalent: 'kici-admin registration delete',
    },
    {
      name: 'global_workflows.update',
      wireMessageType: 'dashboard.global-workflows.update',
      category: 'Topology',
      label: 'Update global workflow policy',
      sensitivity: 'dispatch',
      cliEquivalent: 'kici-admin org-settings global-workflows set',
    },
    {
      name: 'backends.sync',
      wireMessageType: 'dashboard.backends.sync',
      category: 'Topology',
      label: 'Sync all scaler backends',
      sensitivity: 'dispatch',
      cliEquivalent: 'kici-admin backend sync',
    },
    {
      name: 'backends.sync_one',
      wireMessageType: 'dashboard.backends.sync.one',
      category: 'Topology',
      label: 'Sync one scaler backend',
      sensitivity: 'dispatch',
      cliEquivalent: 'kici-admin backend sync --one',
    },
    {
      name: 'backends.test',
      wireMessageType: 'dashboard.backends.test',
      category: 'Topology',
      label: 'Test scaler backend',
      sensitivity: 'dispatch',
      cliEquivalent: 'kici-admin backend test',
    },
  ]);

/** O(1) lookup of a descriptor by operation name. */
export const DASHBOARD_WRITE_OPERATIONS_BY_NAME: ReadonlyMap<
  DashboardWriteOperation,
  DashboardWriteOperationDescriptor
> = new Map(DASHBOARD_WRITE_OPERATIONS.map((d) => [d.name, d]));

/** O(1) lookup of a descriptor by wire-message type. */
export const DASHBOARD_WRITE_OPERATIONS_BY_WIRE_TYPE: ReadonlyMap<
  string,
  DashboardWriteOperationDescriptor
> = new Map(DASHBOARD_WRITE_OPERATIONS.map((d) => [d.wireMessageType, d]));

export function getDashboardWriteOperationDescriptor(
  op: DashboardWriteOperation,
): DashboardWriteOperationDescriptor {
  const descriptor = DASHBOARD_WRITE_OPERATIONS_BY_NAME.get(op);
  if (!descriptor) {
    throw new Error(`No descriptor registered for dashboard write operation: ${op}`);
  }
  return descriptor;
}

export function getDashboardWriteOperationsByCategory(
  category: DashboardWriteCategory,
): readonly DashboardWriteOperationDescriptor[] {
  return DASHBOARD_WRITE_OPERATIONS.filter((d) => d.category === category);
}

export function getDashboardWriteOperationsBySensitivity(
  sensitivity: DashboardWriteSensitivity,
): readonly DashboardWriteOperationDescriptor[] {
  return DASHBOARD_WRITE_OPERATIONS.filter((d) => d.sensitivity === sensitivity);
}

/**
 * Map of operation → enabled flag. Omitted operations default to true
 * (permissive). The orch persists this shape verbatim as JSONB; the
 * Platform mirrors it in its per-org cache.
 */
export type DashboardWritePolicyMap = Partial<Record<DashboardWriteOperation, boolean>>;

/**
 * Validates a sparse policy map. Use this where the value is required
 * but may be empty (e.g. the JSONB column on the orch). For optional
 * fields on outer schemas, embed `dashboardWritePolicyMap` directly
 * with `.optional()` so omission stays as `undefined` rather than being
 * coerced to `{}`.
 */
export const dashboardWritePolicyMap = z.partialRecord(DashboardWriteOperation, z.boolean());

export const dashboardWritePolicyMapSchema = dashboardWritePolicyMap.default({});

/**
 * Resolve the effective state of an operation given a (possibly sparse)
 * policy map. Treats `undefined` as enabled by the permissive default.
 */
export function isDashboardWriteOperationEnabled(
  policy: DashboardWritePolicyMap | null | undefined,
  op: DashboardWriteOperation,
): boolean {
  if (!policy) return true;
  const explicit = policy[op];
  return explicit === undefined ? true : explicit;
}

/**
 * Expand a (possibly sparse) policy map into the full effective state
 * for all 24 operations. Operations the policy doesn't mention come
 * back as `true` (permissive). Used by the orch HTTP admin response,
 * the WS `orch.capabilities` broadcast, and the dashboard's policy
 * page so consumers see the full picture, not the sparse storage shape.
 */
export function resolveFullPolicyView(
  policy: DashboardWritePolicyMap | null | undefined,
): Record<DashboardWriteOperation, boolean> {
  const out = {} as Record<DashboardWriteOperation, boolean>;
  for (const descriptor of DASHBOARD_WRITE_OPERATIONS) {
    out[descriptor.name] = isDashboardWriteOperationEnabled(policy, descriptor.name);
  }
  return out;
}

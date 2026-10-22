/**
 * Registry of dashboard write operations governed by the per-orch
 * dashboard-write policy. Subpath export
 * `@kici-dev/engine/protocol/dashboard-write-operations`; browser-safe (no node
 * built-ins), so the dashboard SPA imports it directly.
 *
 * Readers:
 *   - Orchestrator: enforces the policy per operation in dashboard.* handlers.
 *   - Platform: gates HTTP routes that proxy to the orch.
 *   - Dashboard: renders per-control state (enabled / disabled / loading).
 *
 * A new operation goes in both `DashboardWriteOperation` and
 * `DASHBOARD_WRITE_OPERATIONS`, and chooses its `defaultState` and
 * `allowedStates`; the orchestrator and Platform tests fail until at least one
 * gate handler references it.
 */
import { z } from 'zod';

export const DashboardWriteOperation = z.enum([
  // Secrets — values arrive only sealed in the browser; the Platform relays ciphertext.
  'secrets.set',
  'secrets.delete',
  'secrets.scope.create',
  'secrets.scope.rename',
  'secrets.scope.delete',
  // Variables — plaintext values traverse Platform memory when the posture is permissive.
  'variables.set',
  'variables.delete',
  // Contexts — definition CRUD; no plaintext.
  'contexts.create',
  'contexts.update',
  'contexts.test_access.set',
  'contexts.delete',
  // Bindings and per-source overrides — reshape the resolution tree; no plaintext.
  'contexts.bindings.set',
  'contexts.source_overrides.set',
  'contexts.source_overrides.delete',
  // Held runs — release execution.
  'held_runs.approve',
  'held_runs.reject',
  // DLQ — replay or drop failed webhooks.
  'event_dlq.retry',
  'event_dlq.discard',
  // Attestations — drain the deferred-attestation outbox (mints deferred tokens).
  'attestations.retry',
  // Registrations — DoS-shaped or destructive.
  'registration.disable',
  'registration.delete',
  // Orch topology — config that affects scaler / dispatch.
  'global_workflows.update',
  'backends.sync',
  'backends.sync_one',
  'backends.test',
  // Fleet — host inventory writes (declare / remove); config that affects the fleet.
  'fleet.host.declare',
  'fleet.host.remove',
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
  'contexts.create',
  'contexts.update',
  'contexts.test_access.set',
  'contexts.delete',
  'contexts.bindings.set',
  'contexts.source_overrides.set',
  'contexts.source_overrides.delete',
  'held_runs.approve',
  'held_runs.reject',
  'event_dlq.retry',
  'event_dlq.discard',
  'attestations.retry',
  'registration.disable',
  'registration.delete',
  'global_workflows.update',
  'backends.sync',
  'backends.sync_one',
  'backends.test',
  'fleet.host.declare',
  'fleet.host.remove',
]);

export const DashboardWriteCategory = z.enum([
  'Secrets',
  'Variables',
  'Contexts',
  'Bindings',
  'Held runs',
  'DLQ',
  'Attestations',
  'Registrations',
  'Topology',
  'Fleet',
]);
export type DashboardWriteCategory = z.infer<typeof DashboardWriteCategory>;

export const DashboardWriteSensitivity = z.enum(['plaintext', 'authority', 'dispatch']);
export type DashboardWriteSensitivity = z.infer<typeof DashboardWriteSensitivity>;

/**
 * Per-operation dashboard-write posture.
 *
 *   - `permissive` — the write is accepted and its plaintext value transits
 *     the hosted Platform process.
 *   - `encrypted` — the write is accepted but the value is sealed in the
 *     browser to the orchestrator's published X25519 key, so the Platform
 *     relays only opaque ciphertext. Valid ONLY for `plaintext`-sensitivity
 *     operations (`secrets.set`, `variables.set`): nothing else has a
 *     plaintext payload to seal.
 *   - `disabled` — the write is refused; the operator must use the CLI.
 *
 * The default is per operation (`defaultState`), and so is the allowed set
 * (`allowedStates`): `secrets.set` defaults to `encrypted` and never allows
 * `permissive`; every other operation defaults to `permissive`.
 */
export const DashboardWritePolicyState = z.enum(['permissive', 'encrypted', 'disabled']);
export type DashboardWritePolicyState = z.infer<typeof DashboardWritePolicyState>;

/**
 * Descriptor for one dashboard write operation. The non-enforcement fields
 * (label, cliEquivalent) feed the dashboard SPA's policy-aware UI and the docs
 * generator.
 */
export interface DashboardWriteOperationDescriptor {
  readonly name: DashboardWriteOperation;
  /** The wire message type the operation maps to (dashboard.* on Platform→Orch). */
  readonly wireMessageType: string;
  readonly category: DashboardWriteCategory;
  /** Human-facing label for tooltips and the Security policy page. */
  readonly label: string;
  /** Threat-model bucket — used by docs + the --sensitivity CLI sugar. */
  readonly sensitivity: DashboardWriteSensitivity;
  /**
   * kici-admin invocation hint shown in the CLI snippet copied from the UI.
   * It names a real command path; `--flags` and `<arg>` / `[arg]` placeholders
   * must exist on that command. The orchestrator's cli-equivalents test
   * resolves every entry against the `kici-admin` command tree.
   */
  readonly cliEquivalent: string;
  /** Posture the operation has when the stored policy map omits it. */
  readonly defaultState: DashboardWritePolicyState;
  /** Postures an operator may store for the operation; always includes `defaultState`. */
  readonly allowedStates: readonly DashboardWritePolicyState[];
}

const PERMISSIVE_OR_DISABLED: readonly DashboardWritePolicyState[] = Object.freeze([
  DashboardWritePolicyState.enum.permissive,
  DashboardWritePolicyState.enum.disabled,
]);
const ANY_POSTURE: readonly DashboardWritePolicyState[] = Object.freeze([
  DashboardWritePolicyState.enum.permissive,
  DashboardWritePolicyState.enum.encrypted,
  DashboardWritePolicyState.enum.disabled,
]);
const SEALED_OR_DISABLED: readonly DashboardWritePolicyState[] = Object.freeze([
  DashboardWritePolicyState.enum.encrypted,
  DashboardWritePolicyState.enum.disabled,
]);

export const DASHBOARD_WRITE_OPERATIONS: readonly DashboardWriteOperationDescriptor[] =
  Object.freeze([
    {
      name: 'secrets.set',
      wireMessageType: 'dashboard.contexts.secrets.set',
      category: 'Secrets',
      label: 'Set secret value',
      sensitivity: 'plaintext',
      cliEquivalent: 'kici-admin secret set',
      defaultState: DashboardWritePolicyState.enum.encrypted,
      allowedStates: SEALED_OR_DISABLED,
    },
    {
      name: 'secrets.delete',
      wireMessageType: 'dashboard.contexts.secrets.delete',
      category: 'Secrets',
      label: 'Delete secret',
      sensitivity: 'authority',
      cliEquivalent: 'kici-admin secret delete',
      defaultState: DashboardWritePolicyState.enum.permissive,
      allowedStates: PERMISSIVE_OR_DISABLED,
    },
    {
      name: 'secrets.scope.create',
      wireMessageType: 'dashboard.contexts.secrets.scope.create',
      category: 'Secrets',
      label: 'Create secret scope',
      sensitivity: 'authority',
      cliEquivalent: 'kici-admin secret scope create',
      defaultState: DashboardWritePolicyState.enum.permissive,
      allowedStates: PERMISSIVE_OR_DISABLED,
    },
    {
      name: 'secrets.scope.rename',
      wireMessageType: 'dashboard.contexts.secrets.scope.rename',
      category: 'Secrets',
      label: 'Rename secret scope',
      sensitivity: 'authority',
      cliEquivalent: 'kici-admin secret scope rename',
      defaultState: DashboardWritePolicyState.enum.permissive,
      allowedStates: PERMISSIVE_OR_DISABLED,
    },
    {
      name: 'secrets.scope.delete',
      wireMessageType: 'dashboard.contexts.secrets.scope.delete',
      category: 'Secrets',
      label: 'Delete secret scope',
      sensitivity: 'authority',
      cliEquivalent: 'kici-admin secret scope delete',
      defaultState: DashboardWritePolicyState.enum.permissive,
      allowedStates: PERMISSIVE_OR_DISABLED,
    },
    {
      name: 'variables.set',
      wireMessageType: 'dashboard.contexts.variables.set',
      category: 'Variables',
      label: 'Set variable value',
      sensitivity: 'plaintext',
      cliEquivalent: 'kici-admin variable set',
      defaultState: DashboardWritePolicyState.enum.permissive,
      allowedStates: ANY_POSTURE,
    },
    {
      name: 'variables.delete',
      wireMessageType: 'dashboard.contexts.variables.delete',
      category: 'Variables',
      label: 'Delete variable',
      sensitivity: 'authority',
      cliEquivalent: 'kici-admin variable delete',
      defaultState: DashboardWritePolicyState.enum.permissive,
      allowedStates: PERMISSIVE_OR_DISABLED,
    },
    {
      name: 'contexts.create',
      wireMessageType: 'dashboard.contexts.create',
      category: 'Contexts',
      label: 'Create context',
      sensitivity: 'authority',
      cliEquivalent: 'kici-admin context create',
      defaultState: DashboardWritePolicyState.enum.permissive,
      allowedStates: PERMISSIVE_OR_DISABLED,
    },
    {
      name: 'contexts.update',
      wireMessageType: 'dashboard.contexts.update',
      category: 'Contexts',
      label: 'Update context',
      sensitivity: 'authority',
      cliEquivalent: 'kici-admin context set-policy',
      defaultState: DashboardWritePolicyState.enum.permissive,
      allowedStates: PERMISSIVE_OR_DISABLED,
    },
    {
      name: 'contexts.test_access.set',
      wireMessageType: 'dashboard.contexts.test_access.set',
      category: 'Contexts',
      label: 'Set context test access',
      sensitivity: 'authority',
      cliEquivalent: 'kici-admin context set-policy --allow-local-execution',
      defaultState: DashboardWritePolicyState.enum.permissive,
      allowedStates: PERMISSIVE_OR_DISABLED,
    },
    {
      name: 'contexts.delete',
      wireMessageType: 'dashboard.contexts.delete',
      category: 'Contexts',
      label: 'Delete context',
      sensitivity: 'authority',
      cliEquivalent: 'kici-admin context delete',
      defaultState: DashboardWritePolicyState.enum.permissive,
      allowedStates: PERMISSIVE_OR_DISABLED,
    },
    {
      name: 'contexts.bindings.set',
      wireMessageType: 'dashboard.contexts.bindings.set',
      category: 'Bindings',
      label: 'Set context binding',
      sensitivity: 'authority',
      cliEquivalent: 'kici-admin context bind',
      defaultState: DashboardWritePolicyState.enum.permissive,
      allowedStates: PERMISSIVE_OR_DISABLED,
    },
    {
      name: 'contexts.source_overrides.set',
      wireMessageType: 'dashboard.contexts.source-overrides.set',
      category: 'Bindings',
      label: 'Set source override',
      sensitivity: 'authority',
      cliEquivalent: 'kici-admin context source-override set',
      defaultState: DashboardWritePolicyState.enum.permissive,
      allowedStates: PERMISSIVE_OR_DISABLED,
    },
    {
      name: 'contexts.source_overrides.delete',
      wireMessageType: 'dashboard.contexts.source-overrides.delete',
      category: 'Bindings',
      label: 'Delete source override',
      sensitivity: 'authority',
      cliEquivalent: 'kici-admin context source-override delete',
      defaultState: DashboardWritePolicyState.enum.permissive,
      allowedStates: PERMISSIVE_OR_DISABLED,
    },
    {
      name: 'held_runs.approve',
      wireMessageType: 'dashboard.held-runs.approve',
      category: 'Held runs',
      label: 'Approve held run',
      sensitivity: 'dispatch',
      cliEquivalent: 'kici-admin held-run approve',
      defaultState: DashboardWritePolicyState.enum.permissive,
      allowedStates: PERMISSIVE_OR_DISABLED,
    },
    {
      name: 'held_runs.reject',
      wireMessageType: 'dashboard.held-runs.reject',
      category: 'Held runs',
      label: 'Reject held run',
      sensitivity: 'dispatch',
      cliEquivalent: 'kici-admin held-run reject',
      defaultState: DashboardWritePolicyState.enum.permissive,
      allowedStates: PERMISSIVE_OR_DISABLED,
    },
    {
      name: 'event_dlq.retry',
      wireMessageType: 'dashboard.event-dlq.retry',
      category: 'DLQ',
      label: 'Retry dead-lettered webhook',
      sensitivity: 'dispatch',
      cliEquivalent: 'kici-admin event-dlq retry',
      defaultState: DashboardWritePolicyState.enum.permissive,
      allowedStates: PERMISSIVE_OR_DISABLED,
    },
    {
      name: 'event_dlq.discard',
      wireMessageType: 'dashboard.event-dlq.discard',
      category: 'DLQ',
      label: 'Discard dead-lettered webhook',
      sensitivity: 'dispatch',
      cliEquivalent: 'kici-admin event-dlq discard',
      defaultState: DashboardWritePolicyState.enum.permissive,
      allowedStates: PERMISSIVE_OR_DISABLED,
    },
    {
      name: 'attestations.retry',
      wireMessageType: 'dashboard.attestation.retry',
      category: 'Attestations',
      label: 'Retry deferred attestations',
      sensitivity: 'dispatch',
      cliEquivalent: 'kici-admin attestations retry',
      defaultState: DashboardWritePolicyState.enum.permissive,
      allowedStates: PERMISSIVE_OR_DISABLED,
    },
    {
      name: 'registration.disable',
      wireMessageType: 'dashboard.registration.disable',
      category: 'Registrations',
      label: 'Disable workflow registration',
      sensitivity: 'dispatch',
      cliEquivalent: 'kici-admin registration disable',
      defaultState: DashboardWritePolicyState.enum.permissive,
      allowedStates: PERMISSIVE_OR_DISABLED,
    },
    {
      name: 'registration.delete',
      wireMessageType: 'dashboard.registration.delete',
      category: 'Registrations',
      label: 'Delete workflow registration',
      sensitivity: 'dispatch',
      cliEquivalent: 'kici-admin registration delete',
      defaultState: DashboardWritePolicyState.enum.permissive,
      allowedStates: PERMISSIVE_OR_DISABLED,
    },
    {
      name: 'global_workflows.update',
      wireMessageType: 'dashboard.global-workflows.update',
      category: 'Topology',
      label: 'Update global workflow policy',
      sensitivity: 'dispatch',
      // The group: its allow-add / allow-remove / deny-add / deny-remove leaves
      // together cover the whole-list write the dashboard sends.
      cliEquivalent: 'kici-admin org-settings global-workflows',
      defaultState: DashboardWritePolicyState.enum.permissive,
      allowedStates: PERMISSIVE_OR_DISABLED,
    },
    {
      name: 'backends.sync',
      wireMessageType: 'dashboard.backends.sync',
      category: 'Topology',
      label: 'Sync all scaler backends',
      sensitivity: 'dispatch',
      cliEquivalent: 'kici-admin backend sync',
      defaultState: DashboardWritePolicyState.enum.permissive,
      allowedStates: PERMISSIVE_OR_DISABLED,
    },
    {
      name: 'backends.sync_one',
      wireMessageType: 'dashboard.backends.sync.one',
      category: 'Topology',
      label: 'Sync one scaler backend',
      sensitivity: 'dispatch',
      cliEquivalent: 'kici-admin backend sync <name>',
      defaultState: DashboardWritePolicyState.enum.permissive,
      allowedStates: PERMISSIVE_OR_DISABLED,
    },
    {
      name: 'backends.test',
      wireMessageType: 'dashboard.backends.test',
      category: 'Topology',
      label: 'Test scaler backend',
      sensitivity: 'dispatch',
      cliEquivalent: 'kici-admin backend test',
      defaultState: DashboardWritePolicyState.enum.permissive,
      allowedStates: PERMISSIVE_OR_DISABLED,
    },
    {
      name: 'fleet.host.declare',
      wireMessageType: 'dashboard.fleet.host.declare',
      category: 'Fleet',
      label: 'Declare a static host',
      sensitivity: 'dispatch',
      cliEquivalent: 'kici-admin host declare',
      defaultState: DashboardWritePolicyState.enum.permissive,
      allowedStates: PERMISSIVE_OR_DISABLED,
    },
    {
      name: 'fleet.host.remove',
      wireMessageType: 'dashboard.fleet.host.remove',
      category: 'Fleet',
      label: 'Remove a host from the roster',
      sensitivity: 'dispatch',
      cliEquivalent: 'kici-admin host remove',
      defaultState: DashboardWritePolicyState.enum.permissive,
      allowedStates: PERMISSIVE_OR_DISABLED,
    },
  ]);

/**
 * The operations whose `cliEquivalent` answers only on an **independent**
 * orchestrator. `kici-admin held-run approve` / `reject` refuse with a 409
 * wherever a Platform is attached, because the Platform's held-run trust gate
 * decides who may answer a hold there; every other CLI equivalent works in any
 * mode. A Platform-attached orchestrator therefore refuses to disable these,
 * since nothing else could answer a context or reviewer hold. The
 * orchestrator's policy module and the `dashboard-writes` CLI render both read
 * this list, so the refusal and the warning always name the same operations.
 */
export const CLI_INDEPENDENT_ONLY_OPERATIONS: readonly DashboardWriteOperation[] = Object.freeze([
  'held_runs.approve',
  'held_runs.reject',
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

/** Posture of `op` when the stored policy map omits it. */
export function defaultPolicyState(op: DashboardWriteOperation): DashboardWritePolicyState {
  return getDashboardWriteOperationDescriptor(op).defaultState;
}

/** Whether an operator may store `state` for `op`. */
export function isAllowedPolicyState(
  op: DashboardWriteOperation,
  state: DashboardWritePolicyState,
): boolean {
  return getDashboardWriteOperationDescriptor(op).allowedStates.includes(state);
}

/** Operator-facing refusal for a posture `op` does not allow. */
export function policyStateRefusalMessage(
  op: DashboardWriteOperation,
  state: DashboardWritePolicyState,
): string {
  const allowed = getDashboardWriteOperationDescriptor(op).allowedStates.join(', ');
  return `"${state}" is not allowed for ${op}. Allowed: ${allowed}.`;
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
 * Map of operation → posture. An omitted operation has its own `defaultState`.
 * The orch persists this shape verbatim as JSONB; the Platform mirrors it in
 * its per-org cache.
 */
export type DashboardWritePolicyMap = Partial<
  Record<DashboardWriteOperation, DashboardWritePolicyState>
>;

/**
 * Read and wire shape of a sparse policy map: the orch JSONB column, the
 * `orch.capabilities` broadcast and the Platform cache. A missing key means
 * the operation's default posture. It accepts every posture the operation
 * allows plus the legacy `permissive`, so a stored or broadcast legacy value
 * never discards the whole map; resolution maps that value to the default.
 * It still rejects `encrypted` for an operation with no plaintext payload.
 * Writes use {@link dashboardWritePolicyUpdate}. An optional outer field embeds
 * it with `.optional()` so omission stays `undefined` rather than `{}`.
 */
export const dashboardWritePolicyMap = z
  .partialRecord(DashboardWriteOperation, DashboardWritePolicyState)
  .superRefine((map, ctx) => {
    for (const [op, state] of Object.entries(map)) {
      if (state === undefined || state === DashboardWritePolicyState.enum.permissive) continue;
      if (!isAllowedPolicyState(op as DashboardWriteOperation, state)) {
        ctx.addIssue({
          code: 'custom',
          message: `"encrypted" is only valid for plaintext operations, not "${op}"`,
          path: [op],
        });
      }
    }
  });

export const dashboardWritePolicyMapSchema = dashboardWritePolicyMap.default({});

/**
 * Write shape of a sparse policy map: refuses any posture the operation does
 * not allow, one issue per refused entry. Callers: the orchestrator admin
 * PATCH route and `setDashboardWritePolicy`.
 */
export const dashboardWritePolicyUpdate = z
  .partialRecord(DashboardWriteOperation, DashboardWritePolicyState)
  .superRefine((map, ctx) => {
    for (const [op, state] of Object.entries(map)) {
      if (state === undefined) continue;
      const operation = op as DashboardWriteOperation;
      if (!isAllowedPolicyState(operation, state)) {
        ctx.addIssue({
          code: 'custom',
          message: policyStateRefusalMessage(operation, state),
          path: [op],
        });
      }
    }
  });

/**
 * Effective posture of an operation; an absent entry, or one outside the op's
 * allowed postures, resolves to the op's default.
 */
export function resolvePolicyState(
  policy: DashboardWritePolicyMap | null | undefined,
  op: DashboardWriteOperation,
): DashboardWritePolicyState {
  const stored = policy?.[op];
  return stored !== undefined && isAllowedPolicyState(op, stored) ? stored : defaultPolicyState(op);
}

/** `true` unless the operation's posture is `disabled`. */
export function isDashboardWriteOperationEnabled(
  policy: DashboardWritePolicyMap | null | undefined,
  op: DashboardWriteOperation,
): boolean {
  return resolvePolicyState(policy, op) !== 'disabled';
}

/** True only when the operation's posture is `encrypted`. */
export function isEncryptedState(
  policy: DashboardWritePolicyMap | null | undefined,
  op: DashboardWriteOperation,
): boolean {
  return resolvePolicyState(policy, op) === 'encrypted';
}

/**
 * Expand a sparse policy map into the enabled boolean for every operation;
 * unmentioned operations resolve to their default posture. {@link resolveFullPolicyStateView} gives
 * the tri-state.
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

/**
 * Expand a sparse policy map into the tri-state posture for every operation,
 * for the orch HTTP admin response, the WS `orch.capabilities` broadcast and
 * the dashboard policy page.
 */
export function resolveFullPolicyStateView(
  policy: DashboardWritePolicyMap | null | undefined,
): Record<DashboardWriteOperation, DashboardWritePolicyState> {
  const out = {} as Record<DashboardWriteOperation, DashboardWritePolicyState>;
  for (const descriptor of DASHBOARD_WRITE_OPERATIONS) {
    out[descriptor.name] = resolvePolicyState(policy, descriptor.name);
  }
  return out;
}

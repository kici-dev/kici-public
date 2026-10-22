import { describe, it, expect } from 'vitest';
import {
  DashboardWriteOperation,
  DashboardWritePolicyState,
  DASHBOARD_WRITE_OPERATIONS,
  DASHBOARD_WRITE_OPERATIONS_BY_NAME,
  DASHBOARD_WRITE_OPERATIONS_BY_WIRE_TYPE,
  DASHBOARD_WRITE_OPERATION_VALUES,
  dashboardWritePolicyMap,
  dashboardWritePolicyMapSchema,
  dashboardWritePolicyUpdate,
  defaultPolicyState,
  isAllowedPolicyState,
  policyStateRefusalMessage,
  getDashboardWriteOperationDescriptor,
  getDashboardWriteOperationsByCategory,
  getDashboardWriteOperationsBySensitivity,
  isDashboardWriteOperationEnabled,
  isEncryptedState,
  resolvePolicyState,
  resolveFullPolicyStateView,
  resolveFullPolicyView,
} from './dashboard-write-operations.js';

describe('DashboardWriteOperation enum', () => {
  it('has 27 values', () => {
    expect(DashboardWriteOperation.options).toHaveLength(27);
  });

  it('matches DASHBOARD_WRITE_OPERATION_VALUES exactly', () => {
    expect([...DASHBOARD_WRITE_OPERATION_VALUES]).toEqual(DashboardWriteOperation.options);
  });

  it('has exactly one descriptor per enum value', () => {
    expect(DASHBOARD_WRITE_OPERATIONS).toHaveLength(DashboardWriteOperation.options.length);
    for (const op of DashboardWriteOperation.options) {
      expect(DASHBOARD_WRITE_OPERATIONS_BY_NAME.has(op)).toBe(true);
    }
  });

  it('every descriptor name is a valid enum value', () => {
    for (const descriptor of DASHBOARD_WRITE_OPERATIONS) {
      expect(DashboardWriteOperation.options).toContain(descriptor.name);
    }
  });

  it('wire-message types are all distinct', () => {
    const wireTypes = DASHBOARD_WRITE_OPERATIONS.map((d) => d.wireMessageType);
    expect(new Set(wireTypes).size).toBe(wireTypes.length);
    expect(DASHBOARD_WRITE_OPERATIONS_BY_WIRE_TYPE.size).toBe(wireTypes.length);
  });

  it('every wire-message type starts with "dashboard."', () => {
    for (const descriptor of DASHBOARD_WRITE_OPERATIONS) {
      expect(descriptor.wireMessageType.startsWith('dashboard.')).toBe(true);
    }
  });
});

describe('getDashboardWriteOperationDescriptor', () => {
  it('returns the descriptor for a known operation', () => {
    const d = getDashboardWriteOperationDescriptor('secrets.set');
    expect(d.name).toBe('secrets.set');
    expect(d.category).toBe('Secrets');
    expect(d.sensitivity).toBe('plaintext');
    expect(d.wireMessageType).toBe('dashboard.contexts.secrets.set');
  });

  it('throws on an unknown operation', () => {
    expect(() =>
      getDashboardWriteOperationDescriptor('bogus.op' as unknown as DashboardWriteOperation),
    ).toThrow(/No descriptor registered/);
  });
});

describe('category and sensitivity filters', () => {
  it('groups secrets operations together', () => {
    const secrets = getDashboardWriteOperationsByCategory('Secrets');
    expect(secrets.map((d) => d.name)).toEqual([
      'secrets.set',
      'secrets.delete',
      'secrets.scope.create',
      'secrets.scope.rename',
      'secrets.scope.delete',
    ]);
  });

  it('returns plaintext-sensitive operations', () => {
    const plaintext = getDashboardWriteOperationsBySensitivity('plaintext');
    expect(plaintext.map((d) => d.name).sort()).toEqual(['secrets.set', 'variables.set']);
  });

  it('returns dispatch-sensitive operations', () => {
    const dispatch = getDashboardWriteOperationsBySensitivity('dispatch');
    expect(dispatch.length).toBeGreaterThan(0);
    for (const d of dispatch) {
      expect(d.sensitivity).toBe('dispatch');
    }
  });
});

describe('isDashboardWriteOperationEnabled', () => {
  it('returns true when policy is null', () => {
    expect(isDashboardWriteOperationEnabled(null, 'secrets.set')).toBe(true);
  });

  it('returns true when policy is undefined', () => {
    expect(isDashboardWriteOperationEnabled(undefined, 'secrets.set')).toBe(true);
  });

  it('returns true when the operation is not in the policy map', () => {
    expect(isDashboardWriteOperationEnabled({}, 'secrets.set')).toBe(true);
    expect(isDashboardWriteOperationEnabled({ 'variables.set': 'disabled' }, 'secrets.set')).toBe(
      true,
    );
  });

  it('returns true unless the operation is disabled', () => {
    expect(isDashboardWriteOperationEnabled({ 'secrets.set': 'disabled' }, 'secrets.set')).toBe(
      false,
    );
    expect(isDashboardWriteOperationEnabled({ 'secrets.set': 'permissive' }, 'secrets.set')).toBe(
      true,
    );
    expect(isDashboardWriteOperationEnabled({ 'secrets.set': 'encrypted' }, 'secrets.set')).toBe(
      true,
    );
  });
});

describe('three-state policy', () => {
  it('enum has exactly permissive/encrypted/disabled', () => {
    expect(DashboardWritePolicyState.options).toEqual(['permissive', 'encrypted', 'disabled']);
  });

  it('resolves an absent secrets.set to encrypted', () => {
    // fails-when: the default is read from anywhere but the descriptor (pinned to a literal).
    expect(resolvePolicyState({}, 'secrets.set')).toBe('encrypted');
    expect(resolvePolicyState(null, 'secrets.set')).toBe('encrypted');
  });

  it('resolves every other absent operation to permissive', () => {
    // breaks-if-wrong: a property over the registry, not a hand list.
    for (const op of DASHBOARD_WRITE_OPERATION_VALUES.filter((o) => o !== 'secrets.set'))
      expect(resolvePolicyState({}, op), op).toBe('permissive');
  });

  it('maps a legacy stored permissive secrets.set to encrypted, keeping disabled', () => {
    expect(resolvePolicyState({ 'secrets.set': 'permissive' }, 'secrets.set')).toBe('encrypted');
    expect(isEncryptedState({ 'secrets.set': 'permissive' }, 'secrets.set')).toBe(true);
    expect(resolvePolicyState({ 'secrets.set': 'disabled' }, 'secrets.set')).toBe('disabled');
    expect(resolvePolicyState({ 'variables.set': 'permissive' }, 'variables.set')).toBe(
      'permissive',
    );
  });

  it('the full state view reports secrets.set encrypted and enabled for an empty map', () => {
    expect(resolveFullPolicyStateView({})['secrets.set']).toBe('encrypted');
    expect(resolveFullPolicyView({})['secrets.set']).toBe(true);
  });

  it('isEncryptedState true only for encrypted', () => {
    expect(isEncryptedState({ 'variables.set': 'encrypted' }, 'variables.set')).toBe(true);
    expect(isEncryptedState({ 'variables.set': 'permissive' }, 'variables.set')).toBe(false);
    expect(isEncryptedState({ 'secrets.set': 'disabled' }, 'secrets.set')).toBe(false);
  });

  it('rejects encrypted on a non-plaintext op', () => {
    const r = dashboardWritePolicyMapSchema.safeParse({ 'held_runs.approve': 'encrypted' });
    expect(r.success).toBe(false);
  });

  it('accepts encrypted on a plaintext op', () => {
    expect(dashboardWritePolicyMapSchema.safeParse({ 'secrets.set': 'encrypted' }).success).toBe(
      true,
    );
    expect(dashboardWritePolicyMapSchema.safeParse({ 'variables.set': 'encrypted' }).success).toBe(
      true,
    );
  });

  it('refuses boolean policy values (the tri-state is the only shape)', () => {
    // fails-when: a boolean is coerced instead of refused.
    expect(dashboardWritePolicyMapSchema.safeParse({ 'held_runs.approve': true }).success).toBe(
      false,
    );
    expect(dashboardWritePolicyMapSchema.safeParse({ 'secrets.set': false }).success).toBe(false);
  });

  it('accepts every tri-state value on a plaintext op', () => {
    // breaks-if-wrong: the current enum shape still parses.
    for (const state of DashboardWritePolicyState.options) {
      expect(dashboardWritePolicyMapSchema.parse({ 'secrets.set': state })).toEqual({
        'secrets.set': state,
      });
    }
  });

  it('read schema accepts exactly what it accepted before per-op postures', () => {
    // Pinned against `sensitivity`, not `allowedStates`, so it cannot pass by construction.
    // fails-when: the read schema rejects a legacy `permissive` for secrets.set.
    for (const d of DASHBOARD_WRITE_OPERATIONS)
      for (const s of DashboardWritePolicyState.options)
        expect(dashboardWritePolicyMap.safeParse({ [d.name]: s }).success, `${d.name}=${s}`).toBe(
          s !== 'encrypted' || d.sensitivity === 'plaintext',
        );
  });

  it('resolveFullPolicyStateView expands sparse map to all ops', () => {
    const view = resolveFullPolicyStateView({ 'secrets.set': 'encrypted' });
    expect(view['secrets.set']).toBe('encrypted');
    expect(view['held_runs.approve']).toBe('permissive');
    expect(Object.keys(view)).toHaveLength(DashboardWriteOperation.options.length);
  });
});

describe('dashboardWritePolicyMapSchema', () => {
  it('accepts an empty object', () => {
    expect(dashboardWritePolicyMapSchema.parse({})).toEqual({});
  });

  it('accepts a partial map of known operations', () => {
    const policy = { 'secrets.set': 'disabled', 'variables.set': 'disabled' } as const;
    expect(dashboardWritePolicyMapSchema.parse(policy)).toEqual(policy);
  });

  it('rejects unknown operation keys', () => {
    expect(() => dashboardWritePolicyMapSchema.parse({ 'bogus.op': 'disabled' })).toThrow();
  });

  it('rejects invalid state values', () => {
    expect(() => dashboardWritePolicyMapSchema.parse({ 'secrets.set': 'no' })).toThrow();
  });

  it('defaults to empty object when input is undefined', () => {
    expect(dashboardWritePolicyMapSchema.parse(undefined)).toEqual({});
  });
});

describe('per-operation postures', () => {
  it('every descriptor allows its own default', () => {
    // fails-when: a descriptor's defaultState is outside its allowedStates.
    for (const d of DASHBOARD_WRITE_OPERATIONS)
      expect(d.allowedStates, d.name).toContain(d.defaultState);
  });

  it('only plaintext-sensitivity operations allow encrypted', () => {
    // Pinned against `sensitivity`, an independently authored field.
    for (const d of DASHBOARD_WRITE_OPERATIONS)
      expect(d.allowedStates.includes('encrypted'), d.name).toBe(d.sensitivity === 'plaintext');
  });

  it('secrets.set defaults to encrypted and allows only encrypted or disabled', () => {
    const d = getDashboardWriteOperationDescriptor('secrets.set');
    expect(d.defaultState).toBe('encrypted');
    expect(defaultPolicyState('secrets.set')).toBe('encrypted');
    expect([...d.allowedStates].sort()).toEqual(['disabled', 'encrypted']);
    expect(isAllowedPolicyState('secrets.set', 'permissive')).toBe(false);
  });

  it('every other operation defaults to permissive', () => {
    for (const d of DASHBOARD_WRITE_OPERATIONS.filter((x) => x.name !== 'secrets.set'))
      expect(d.defaultState, d.name).toBe('permissive');
  });

  it('variables.set keeps every posture', () => {
    expect([...getDashboardWriteOperationDescriptor('variables.set').allowedStates].sort()).toEqual(
      [...DashboardWritePolicyState.options].sort(),
    );
  });

  it('policyStateRefusalMessage names the allowed postures', () => {
    expect(policyStateRefusalMessage('secrets.set', 'permissive')).toBe(
      '"permissive" is not allowed for secrets.set. Allowed: encrypted, disabled.',
    );
  });
});

describe('dashboardWritePolicyUpdate', () => {
  it('refuses permissive for secrets.set and names the allowed postures', () => {
    const r = dashboardWritePolicyUpdate.safeParse({ 'secrets.set': 'permissive' });
    expect(r.success).toBe(false);
    expect(r.error!.issues[0]!.message).toBe(
      '"permissive" is not allowed for secrets.set. Allowed: encrypted, disabled.',
    );
    expect(r.error!.issues[0]!.path).toEqual(['secrets.set']);
  });

  it('refuses encrypted for an authority operation', () => {
    expect(dashboardWritePolicyUpdate.safeParse({ 'held_runs.approve': 'encrypted' }).success).toBe(
      false,
    );
  });

  it('accepts every allowed posture', () => {
    // breaks-if-wrong: the legitimate writes still parse.
    for (const u of [
      { 'secrets.set': 'disabled' },
      { 'secrets.set': 'encrypted' },
      { 'variables.set': 'permissive' },
      { 'variables.set': 'encrypted' },
      { 'event_dlq.retry': 'disabled' },
    ])
      expect(dashboardWritePolicyUpdate.safeParse(u).success, JSON.stringify(u)).toBe(true);
  });

  it('rejects an unknown operation key', () => {
    expect(dashboardWritePolicyUpdate.safeParse({ 'bogus.op': 'disabled' }).success).toBe(false);
  });
});

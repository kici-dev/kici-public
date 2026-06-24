import { describe, it, expect } from 'vitest';
import {
  DASHBOARD_WRITE_OPERATIONS,
  DASHBOARD_WRITE_OPERATION_VALUES,
  DASHBOARD_WRITE_OPERATIONS_BY_NAME,
} from './dashboard-write-operations.js';

describe('fleet host write ops', () => {
  it('declare + remove are registered in the Fleet category with dispatch sensitivity', () => {
    for (const name of ['fleet.host.declare', 'fleet.host.remove'] as const) {
      expect(DASHBOARD_WRITE_OPERATION_VALUES).toContain(name);
      const d = DASHBOARD_WRITE_OPERATIONS_BY_NAME.get(name);
      expect(d).toBeDefined();
      expect(d!.category).toBe('Fleet');
      expect(d!.sensitivity).toBe('dispatch');
      expect(d!.wireMessageType).toBe(`dashboard.${name}`);
    }
    expect(DASHBOARD_WRITE_OPERATIONS.some((o) => o.category === 'Fleet')).toBe(true);
  });
});

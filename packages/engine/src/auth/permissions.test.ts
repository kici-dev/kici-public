import { describe, expect, it } from 'vitest';
import {
  ALL_RESOURCES,
  PERMISSION_HIERARCHY,
  hasPermission,
  type Permissions,
} from './permissions.js';

const none = Object.fromEntries(ALL_RESOURCES.map((r) => [r, 'none'])) as Permissions;

describe('hasPermission', () => {
  // fails-when: the hierarchy comparison is inverted
  it('grants a lower level when a higher one is held, and refuses a higher one', () => {
    expect(hasPermission({ ...none, runs: 'write' }, 'runs', 'read')).toBe(true);
    expect(hasPermission({ ...none, runs: 'read' }, 'runs', 'write')).toBe(false);
    expect(hasPermission({ ...none, runs: 'admin' }, 'runs', 'admin')).toBe(true);
  });

  it('treats a missing resource as none', () => {
    expect(hasPermission({} as Permissions, 'runs', 'read')).toBe(false);
    expect(hasPermission({} as Permissions, 'runs', 'none')).toBe(true);
  });

  it('orders read_payload between read and write', () => {
    expect(PERMISSION_HIERARCHY.read).toBeLessThan(PERMISSION_HIERARCHY.read_payload);
    expect(PERMISSION_HIERARCHY.read_payload).toBeLessThan(PERMISSION_HIERARCHY.write);
  });
});

describe('ALL_RESOURCES', () => {
  // The dashboard renders the role editor rows in this order.
  it('keeps the display order', () => {
    expect(ALL_RESOURCES).toEqual([
      'runs',
      'api_keys',
      'webhook_sources',
      'org_settings',
      'members',
      'secrets',
      'workflows',
      'billing',
      'audit',
      'contexts',
      'ci_trust',
      'webhook_endpoints',
      'event_log',
      'event_dlq',
      'support',
      'teams',
      'fleet',
      'notifications',
    ]);
  });
});

import { describe, expect, it } from 'vitest';
import {
  coerceHostPropertyValue,
  HostInventoryEntry,
  parseHostPropertyAssignments,
} from './inventory.js';

describe('HostInventoryEntry', () => {
  it('accepts a full inventory entry with typed properties', () => {
    const e = HostInventoryEntry.parse({
      agentId: 'box-1',
      labels: ['role=db'],
      properties: { region: 'eu', cores: 8, gpu: true },
      hostname: 'box-1',
      platform: 'linux',
      arch: 'x64',
      lifecycleClass: 'static',
      status: 'ready',
      lastSeen: '2026-06-21T00:00:00.000Z',
    });
    expect(e.properties.cores).toBe(8);
    expect(e.properties.region).toBe('eu');
    expect(e.properties.gpu).toBe(true);
  });

  it('accepts nullable host fields and an empty property bag', () => {
    const e = HostInventoryEntry.parse({
      agentId: 'b',
      labels: [],
      properties: {},
      hostname: null,
      platform: null,
      arch: null,
      lifecycleClass: 'ephemeral',
      status: 'stale',
      lastSeen: 'x',
    });
    expect(e.hostname).toBeNull();
    expect(e.properties).toEqual({});
  });

  it('rejects a non-primitive property value', () => {
    expect(() =>
      HostInventoryEntry.parse({
        agentId: 'b',
        labels: [],
        properties: { bad: { nested: 1 } },
        hostname: null,
        platform: null,
        arch: null,
        lifecycleClass: 'ephemeral',
        status: 'stale',
        lastSeen: 'x',
      }),
    ).toThrow();
  });

  it('rejects an unknown lifecycleClass or status', () => {
    expect(() =>
      HostInventoryEntry.parse({
        agentId: 'b',
        labels: [],
        properties: {},
        hostname: null,
        platform: null,
        arch: null,
        lifecycleClass: 'bogus',
        status: 'ready',
        lastSeen: 'x',
      }),
    ).toThrow();
    expect(() =>
      HostInventoryEntry.parse({
        agentId: 'b',
        labels: [],
        properties: {},
        hostname: null,
        platform: null,
        arch: null,
        lifecycleClass: 'static',
        status: 'bogus',
        lastSeen: 'x',
      }),
    ).toThrow();
  });
});

describe('coerceHostPropertyValue', () => {
  it('coerces booleans, integers, decimals; leaves other strings', () => {
    expect(coerceHostPropertyValue('true')).toBe(true);
    expect(coerceHostPropertyValue('false')).toBe(false);
    expect(coerceHostPropertyValue('8')).toBe(8);
    expect(coerceHostPropertyValue('-3')).toBe(-3);
    expect(coerceHostPropertyValue('1.5')).toBe(1.5);
    expect(coerceHostPropertyValue('eu')).toBe('eu');
    expect(coerceHostPropertyValue('1.2.3')).toBe('1.2.3');
    expect(coerceHostPropertyValue('')).toBe('');
  });
});

describe('parseHostPropertyAssignments', () => {
  it('parses key=value entries into a typed bag', () => {
    expect(parseHostPropertyAssignments(['region=eu', 'cores=8', 'gpu=true'])).toEqual({
      region: 'eu',
      cores: 8,
      gpu: true,
    });
  });

  it('keeps a value containing = intact after the first =', () => {
    expect(parseHostPropertyAssignments(['url=https://x?a=b'])).toEqual({
      url: 'https://x?a=b',
    });
  });

  it('throws on a malformed entry (no =) or empty key', () => {
    expect(() => parseHostPropertyAssignments(['noequals'])).toThrow();
    expect(() => parseHostPropertyAssignments(['=novalue'])).toThrow();
  });
});

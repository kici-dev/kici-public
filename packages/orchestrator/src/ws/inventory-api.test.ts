import { describe, expect, it, vi } from 'vitest';
import { HostInventoryEntry, type InventorySelector } from '@kici-dev/engine';
import { createInventoryGetHandler, createInventoryQueryHandler } from './inventory-api.js';

const sampleEntry = (over: Partial<HostInventoryEntry> = {}): HostInventoryEntry => ({
  agentId: 'box-1',
  labels: ['role:db'],
  properties: { region: 'eu' },
  hostname: 'box-1',
  platform: 'linux',
  arch: 'x64',
  lifecycleClass: 'static',
  status: 'ready',
  lastSeen: '2026-06-21T00:00:00.000Z',
  ...over,
});

describe('createInventoryQueryHandler', () => {
  it('returns the roster as validated HostInventoryEntry[] when params are empty', async () => {
    const queryInventory = vi.fn().mockResolvedValue([sampleEntry()]);
    const handler = createInventoryQueryHandler({
      rosterStore: { queryInventory } as never,
      graceMs: 1000,
    });
    const result = (await handler('caller', {})) as HostInventoryEntry[];
    expect(queryInventory).toHaveBeenCalledWith(undefined, 1000);
    // Output is valid against the schema.
    expect(() => HostInventoryEntry.array().parse(result)).not.toThrow();
    expect(result[0].agentId).toBe('box-1');
  });

  it('passes a parsed label selector to the store', async () => {
    const queryInventory = vi.fn().mockResolvedValue([]);
    const handler = createInventoryQueryHandler({
      rosterStore: { queryInventory } as never,
      graceMs: 1000,
    });
    const selector: InventorySelector = {
      include: [[{ kind: 'exact', value: 'role:db' }]],
      exclude: [{ kind: 'exact', value: 'role:web' }],
    };
    await handler('caller', selector as unknown as Record<string, unknown>);
    expect(queryInventory).toHaveBeenCalledWith(
      {
        include: [[{ kind: 'exact', value: 'role:db' }]],
        exclude: [{ kind: 'exact', value: 'role:web' }],
      },
      1000,
    );
  });

  it('rejects an invalid selector (malformed matcher)', async () => {
    const queryInventory = vi.fn();
    const handler = createInventoryQueryHandler({
      rosterStore: { queryInventory } as never,
      graceMs: 1000,
    });
    await expect(handler('caller', { include: [[{ kind: 'bogus' }]] })).rejects.toThrow();
    expect(queryInventory).not.toHaveBeenCalled();
  });
});

describe('createInventoryGetHandler', () => {
  it('returns a single entry for a valid agentId', async () => {
    const getInventory = vi.fn().mockResolvedValue(sampleEntry({ agentId: 'g1' }));
    const handler = createInventoryGetHandler({
      rosterStore: { getInventory } as never,
      graceMs: 1000,
    });
    const result = (await handler('caller', { agentId: 'g1' })) as HostInventoryEntry | null;
    expect(getInventory).toHaveBeenCalledWith('g1', 1000);
    expect(result?.agentId).toBe('g1');
  });

  it('returns null when the host is absent', async () => {
    const getInventory = vi.fn().mockResolvedValue(null);
    const handler = createInventoryGetHandler({
      rosterStore: { getInventory } as never,
      graceMs: 1000,
    });
    expect(await handler('caller', { agentId: 'missing' })).toBeNull();
  });

  it('rejects a missing/blank agentId', async () => {
    const getInventory = vi.fn();
    const handler = createInventoryGetHandler({
      rosterStore: { getInventory } as never,
      graceMs: 1000,
    });
    await expect(handler('caller', {})).rejects.toThrow();
    expect(getInventory).not.toHaveBeenCalled();
  });
});

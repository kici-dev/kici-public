import { describe, it, expect } from 'vitest';
import { createMockDb } from '../__test-helpers__/mock-db.js';
import { getClusterId } from './cluster-id.js';

describe('getClusterId', () => {
  it('returns the stored UUID value', async () => {
    const { db } = createMockDb({
      selectFirstRow: { value: '550e8400-e29b-41d4-a716-446655440000' },
    });
    expect(await getClusterId(db)).toBe('550e8400-e29b-41d4-a716-446655440000');
  });

  it('throws when no row exists', async () => {
    const { db } = createMockDb({ selectFirstRow: undefined });
    await expect(getClusterId(db)).rejects.toThrow(/initial schema migration must run before boot/);
  });
});

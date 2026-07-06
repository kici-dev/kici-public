import { describe, expect, it } from 'vitest';
import { computeStatementHash } from './statement-hash.js';

describe('computeStatementHash', () => {
  it('returns a lowercase 64-char hex SHA-256 of the payload bytes', async () => {
    const bytes = new TextEncoder().encode('{"_type":"x"}');
    const h = await computeStatementHash(bytes);
    expect(h).toMatch(/^[0-9a-f]{64}$/);
  });
  it('is stable for identical input and differs for different input', async () => {
    const a = await computeStatementHash(new TextEncoder().encode('a'));
    const a2 = await computeStatementHash(new TextEncoder().encode('a'));
    const b = await computeStatementHash(new TextEncoder().encode('b'));
    expect(a).toBe(a2);
    expect(a).not.toBe(b);
  });
});

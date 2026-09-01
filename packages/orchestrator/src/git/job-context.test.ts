import { describe, it, expect, vi } from 'vitest';
import { createJobCredentialContextReader } from './job-context.js';

function fakeDb(row: { customer_id: string; repo_identifier: string } | undefined) {
  const executeTakeFirst = vi.fn().mockResolvedValue(row);
  const chain = {
    select: () => chain,
    where: () => chain,
    executeTakeFirst,
  };
  return { selectFrom: vi.fn(() => chain) } as never;
}

describe('createJobCredentialContextReader', () => {
  it('reads the org and source repo from the run row, not from params', async () => {
    const read = createJobCredentialContextReader(
      fakeDb({ customer_id: 'org-1', repo_identifier: 'cmaster11/main' }),
    );
    await expect(read('run-1')).resolves.toEqual({
      orgId: 'org-1',
      sourceRepo: 'cmaster11/main',
    });
  });

  it('returns null for an unknown run rather than a default org', async () => {
    const read = createJobCredentialContextReader(fakeDb(undefined));
    await expect(read('nope')).resolves.toBeNull();
  });
});

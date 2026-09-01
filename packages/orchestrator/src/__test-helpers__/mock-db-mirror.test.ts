import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The `createMockDb` query evaluator is duplicated, so it needs a drift guard.
 *
 * The orchestrator and the Platform each own an independent `createMockDb`
 * builder, and neither package depends on the other, so the shared evaluator
 * cannot simply be imported across the boundary. Putting it in `@kici-dev/shared`
 * is worse: that package is published, and test-only code has no business on a
 * public surface (`.claude/rules/public-surface-no-test-fields.md`).
 *
 * So the file is copied, and this test — present in both packages — asserts the
 * copies are byte-identical. A fix applied to one and not the other fails here
 * rather than quietly leaving one package's filters weaker than the other's.
 */
const REPO_ROOT = resolve(import.meta.dirname, '..', '..', '..', '..');

const MIRRORED_FILES = [
  'src/__test-helpers__/mock-db-query.ts',
  'src/__test-helpers__/mock-db-query.test.ts',
  'src/__test-helpers__/mock-db.applies-query.test.ts',
] as const;

describe('mock-db-query mirror', () => {
  it.each(MIRRORED_FILES)('%s is byte-identical across orchestrator and platform', (rel) => {
    const orchestrator = readFileSync(resolve(REPO_ROOT, 'packages/orchestrator', rel), 'utf8');
    const platform = readFileSync(resolve(REPO_ROOT, 'packages/platform', rel), 'utf8');
    expect(platform).toBe(orchestrator);
  });

  it('reads real files, so an identical-empty-string result cannot pass vacuously', () => {
    const source = readFileSync(
      resolve(REPO_ROOT, 'packages/orchestrator', MIRRORED_FILES[0]),
      'utf8',
    );
    expect(source).toContain('export function parseWhereArgs');
    expect(source.length).toBeGreaterThan(1000);
  });
});

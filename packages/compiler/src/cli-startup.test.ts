import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

// The compiled CLI is what ships; assert against source for the lazy-import contract.
describe('cli.ts lazy command loading', () => {
  it('does not statically import any ./commands/* module at top level', () => {
    const src = readFileSync(path.join(__dirname, 'cli.ts'), 'utf8');
    // Top-level (non-dynamic) imports from ./commands/ are forbidden.
    const staticCommandImport = /^import\s+[^;]*from\s+['"]\.\/commands\//m;
    expect(staticCommandImport.test(src)).toBe(false);
  });
});

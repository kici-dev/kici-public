import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const LOADER = '@kici-dev/shared/load-service-env-file';

/** The module specifier of the first import declaration in `file`. */
function firstImport(file: string): string | undefined {
  const source = readFileSync(new URL(file, import.meta.url), 'utf-8');
  return /^import\s[^;]*?['"]([^'"]+)['"]/m.exec(source)?.[1];
}

describe('service entry points', () => {
  // fails-when: any import precedes the loader — that module (and its
  // dependencies) evaluates before the env file is applied.
  it.each(['./server.ts'])('%s imports the env-file loader before any other module', (file) => {
    expect(firstImport(file)).toBe(LOADER);
  });
});

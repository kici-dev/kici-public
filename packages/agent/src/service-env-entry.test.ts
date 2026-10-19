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

  // fails-when: the call is removed or placed after initTelemetry — `--help` would then
  // start telemetry (or, further down, load config) before printing.
  it('server.ts handles CLI arguments before telemetry starts', () => {
    const source = readFileSync(new URL('./server.ts', import.meta.url), 'utf-8');
    const cliCall = source.indexOf('handleAgentCliArgs(process.argv.slice(2))');
    expect(cliCall).toBeGreaterThanOrEqual(0);
    expect(cliCall).toBeLessThan(source.indexOf('initTelemetry({'));
  });
});

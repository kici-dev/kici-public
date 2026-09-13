import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// packages/compiler/src -> repo root
const REPO_ROOT = path.resolve(__dirname, '../../..');
// The real CLI entrypoint customers run: the `kici` bin shim, which lazily
// `await import('@kici-dev/compiler/cli')`. Tracing it (rather than dist/cli.js
// directly) proves the production entrypoint's load closure stays light.
const KICI_BIN = path.resolve(REPO_ROOT, 'packages/kici/bin/kici.js');
const TRACER = path.resolve(__dirname, '../hack/trace-loaded-modules.mjs');

// Heavy server-side dependencies that must NEVER be pulled into the `kici`
// CLI's `--version` load closure. A static import re-introducing any of these
// (the OpenTelemetry SDK, AWS SDK, the Kysely query builder, the pg driver, or
// the Hono HTTP framework) would re-inflate CLI startup from ~0.07s to ~3.3s.
const FORBIDDEN = ['@opentelemetry', '@aws-sdk', 'kysely', 'pg', 'hono'] as const;

const SPAWN_TIMEOUT_MS = 30_000;

// Match `pg` precisely: the bare specifier, a subpath import (`pg/...`), or a
// node_modules path segment (`.../node_modules/pg/...`). A naive substring
// check would false-positive on unrelated specifiers like `picocolors`.
function loadsForbidden(specifier: string, forbidden: string): boolean {
  if (forbidden === 'pg') {
    return (
      specifier === 'pg' ||
      specifier.startsWith('pg/') ||
      specifier.includes('/pg/') ||
      specifier.includes('node_modules/pg')
    );
  }
  // Scoped / unambiguous package names: a substring match is safe.
  return specifier.includes(forbidden);
}

function traceVersionClosure(): string[] {
  const traceDir = mkdtempSync(path.join(os.tmpdir(), 'kici-trace-'));
  const traceFile = path.join(traceDir, 'specifiers.txt');
  try {
    execFileSync(process.execPath, ['--import', TRACER, KICI_BIN, '--version'], {
      encoding: 'utf-8',
      timeout: SPAWN_TIMEOUT_MS,
      env: { ...process.env, KICI_TRACE_FILE: traceFile },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const raw = readFileSync(traceFile, 'utf-8');
    return raw
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
  } finally {
    rmSync(traceDir, { recursive: true, force: true });
  }
}

describe('kici --version load closure', () => {
  it(
    'loads none of the heavy server dependencies',
    () => {
      const specifiers = traceVersionClosure();

      // Guard against a broken tracer silently capturing nothing — an empty
      // trace would make the forbidden-deps assertion below vacuously pass.
      // A working trace of `kici --version` always resolves at least the
      // commander argument parser and the compiler CLI entrypoint.
      expect(specifiers.length).toBeGreaterThan(0);
      expect(specifiers).toContain('commander');
      expect(specifiers.some((s) => s.includes('@kici-dev/compiler'))).toBe(true);

      const offenders = specifiers.filter((specifier) =>
        FORBIDDEN.some((forbidden) => loadsForbidden(specifier, forbidden)),
      );

      expect(
        offenders,
        `kici --version pulled in forbidden heavy dependencies: ${offenders.join(', ')}`,
      ).toEqual([]);
    },
    SPAWN_TIMEOUT_MS + 5_000,
  );
});

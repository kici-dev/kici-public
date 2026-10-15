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
// The `kici` bin shim customers run, which lazily imports
// `@kici-dev/compiler/cli`: tracing it, not dist/cli.js, covers the real closure.
const KICI_BIN = path.resolve(REPO_ROOT, 'packages/kici/bin/kici.js');
const TRACER = path.resolve(__dirname, '../hack/trace-loaded-modules.mjs');

// Server-side dependencies that must NEVER enter the `kici --version` load
// closure: a static import of any of them inflates CLI startup from ~0.07s to ~3.3s.
const FORBIDDEN = ['@opentelemetry', '@aws-sdk', 'kysely', 'pg', 'hono'] as const;

const SPAWN_TIMEOUT_MS = 30_000;

// `pg` matches only as the bare specifier, a `pg/...` subpath or a
// `node_modules/pg/` segment: a substring check would match `picocolors`.
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

      // An empty trace would pass the forbidden-deps assertion vacuously; a
      // working one always resolves commander and the compiler CLI entrypoint.
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

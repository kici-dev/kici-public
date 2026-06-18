/**
 * Defense-in-depth coverage invariant for the orch-side dashboard-write
 * policy gate. Asserts every operation in `DASHBOARD_WRITE_OPERATIONS`
 * has at least one `enforcePolicy(msg, '<op>', ...)` or
 * `assertDashboardWriteAllowed(..., '<op>')` call somewhere under
 * `packages/orchestrator/src/`. The check is a static grep — fast,
 * deterministic, impossible to fool with mocks.
 *
 * Why this exists: every mutating dashboard.* handler needs the gate so
 * the orch refuses the request when the operator has the operation
 * switched off. Without this test, adding a new operation to the
 * registry and forgetting to gate the matching handler would silently
 * leave that operation un-gated on the orch — Platform's middleware
 * would still catch it (its own static-grep test fires), but the
 * orch-side defense-in-depth layer would be missing.
 *
 * The pair: the Platform-side `policy-gate-coverage.test.ts` asserts
 * the same shape against the HTTP route layer.
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DASHBOARD_WRITE_OPERATIONS } from '@kici-dev/engine/protocol/dashboard-write-operations';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SRC_ROOT = join(__dirname, '..');

function collectTsSources(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    const stat = statSync(path);
    if (stat.isDirectory()) {
      out.push(...collectTsSources(path));
      continue;
    }
    if (!entry.endsWith('.ts')) continue;
    if (entry.endsWith('.test.ts') || entry.endsWith('.spec.ts')) continue;
    out.push(path);
  }
  return out;
}

function loadHandlerSources(): string {
  return collectTsSources(SRC_ROOT)
    .map((p) => readFileSync(p, 'utf8'))
    .join('\n');
}

describe('dashboard-write policy orch-side gate coverage', () => {
  it('every DashboardWriteOperation has at least one orch-side enforcePolicy or assertDashboardWriteAllowed call', () => {
    const sources = loadHandlerSources();
    const missing: string[] = [];

    for (const descriptor of DASHBOARD_WRITE_OPERATIONS) {
      const op = descriptor.name;
      const escaped = op.replace(/\./g, '\\.');
      // Match either:
      //   enforcePolicy(<msg>, '<op>', ...) — the per-handler helper.
      //   assertDashboardWriteAllowed(<db>, <orgId>, '<op>') — the
      //   underlying primitive (in case a caller bypasses the helper).
      const enforcePattern = new RegExp(`enforcePolicy\\([\\s\\S]*?['"\`]${escaped}['"\`]`);
      const assertPattern = new RegExp(
        `assertDashboardWriteAllowed\\([^,]+,[^,]+,\\s*['"\`]${escaped}['"\`]`,
      );
      if (!enforcePattern.test(sources) && !assertPattern.test(sources)) {
        missing.push(op);
      }
    }

    expect(missing, `un-gated operations on orch side: ${missing.join(', ')}`).toEqual([]);
  });

  it('every orch-side gate call targets a known operation', () => {
    const sources = loadHandlerSources();
    const known = new Set(DASHBOARD_WRITE_OPERATIONS.map((d) => d.name));
    const calls = [...sources.matchAll(/enforcePolicy\(\s*[^,]+,\s*['"`]([a-z_.]+)['"`]\s*,/g)].map(
      (m) => m[1],
    );

    const unknown = calls.filter((op) => !known.has(op as never));
    expect(unknown, `enforcePolicy called with unknown ops: ${unknown.join(', ')}`).toEqual([]);
  });
});

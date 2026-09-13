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
      //
      // The op literal MUST be the direct 2nd argument of an enforcePolicy
      // call — not merely present somewhere after an enforcePolicy( token.
      // A lazy `[\s\S]*?` wildcard would span the whole joined corpus and
      // let an op string appearing anywhere (another handler, the registry,
      // a comment) satisfy the gate for an operation that is actually
      // un-gated. Anchoring on `enforcePolicy(<first-arg>, '<op>'` keeps the
      // match scoped to a genuine gate call site.
      //
      // The first argument is either a simple expression (`msg`) or an inline
      // object literal that itself contains commas
      // (`{ actor: msg.actor, requestId: msg.requestId, orgId: ... }`, as in
      // handleAttestationRetry). So FIRST_ARG accepts a single-level `{...}`
      // object OR a run of non-comma/brace/paren chars — but not a bare
      // comma-spanning wildcard, which is what would re-open the false-green.
      // A future first-arg shape with nested braces or a paren call would fail
      // to match (safe direction: it surfaces as an apparent gap to inspect,
      // never a silent false-green).
      const FIRST_ARG = '(?:\\{[^{}]*\\}|[^,{}()]+)';
      const enforcePattern = new RegExp(
        `enforcePolicy\\(\\s*${FIRST_ARG},\\s*['"\`]${escaped}['"\`]`,
      );
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
    // Same first-arg shape as the coverage regex above: the op is the direct
    // 2nd argument, and the first argument may be an inline object literal
    // carrying commas (handleAttestationRetry) — so we must not stop the
    // first-arg match at the first comma.
    const calls = [
      ...sources.matchAll(
        /enforcePolicy\(\s*(?:\{[^{}]*\}|[^,{}()]+),\s*['"`]([a-z_.]+)['"`]\s*,/g,
      ),
    ].map((m) => m[1]);

    const unknown = calls.filter((op) => !known.has(op as never));
    expect(unknown, `enforcePolicy called with unknown ops: ${unknown.join(', ')}`).toEqual([]);
  });
});

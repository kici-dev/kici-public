import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Two exported types with the same name in one package read as one type to
 * anyone grepping for it, and a check written against one of them silently
 * describes the other. That already happened on this codebase: a search for the
 * consumers of `TeamMembershipLookup` found a second, dead declaration and
 * reported the wrong module as its home.
 *
 * So the sweep is a ratchet rather than a one-off. Every name below is a pair
 * that genuinely names two DIFFERENT things; anything else — an identical alias
 * re-declared beside a consumer, most often — is the drift this catches, and
 * the fix is to define it once and re-export.
 */
const KNOWN_DISTINCT_HOMONYMS: Record<string, string> = {
  // The flat runtime config (`config.ts`, what `loadConfig` returns) vs the
  // merged local+DB shape the two-phase resolver builds (`config/types.ts`).
  AppConfig: 'two different config shapes: the runtime one and the resolver one',
  // A dispatch-queue row (`queue/job-queue.ts`) vs a concurrency-group queue
  // entry (`concurrency/queue-manager.ts`). Different tables, different fields.
  QueuedJob: 'a dispatch-queue row vs a concurrency-group queue entry',
  // The GitHub App display-name refresher vs the agent-package refresher.
  RefreshResult: 'the app-name refresher result vs the agent-packaging one',
  // A scaler backend config verdict (`scaler/types.ts`) vs a webhook source
  // validation verdict (`sources/source-validator.ts`).
  ValidationResult: 'a scaler config verdict vs a source-validation verdict',
};

const SRC_ROOT = fileURLToPath(new URL('.', import.meta.url));

/** Every non-test `.ts` file under `src`, as absolute paths. */
function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      sourceFiles(full, out);
      continue;
    }
    if (!entry.endsWith('.ts')) continue;
    if (entry.endsWith('.test.ts') || entry.endsWith('.d.ts')) continue;
    out.push(full);
  }
  return out;
}

/**
 * Exported type-ish declarations, by name, to the files declaring them.
 *
 * Deliberately line-anchored on `export type|interface|enum` at column 0: a
 * re-export (`export type { X };`) is NOT a declaration and must not count, or
 * the fix this test asks for would itself trip it.
 */
function declarationsByName(): Map<string, string[]> {
  const byName = new Map<string, string[]>();
  const declaration = /^export (?:type|interface|enum|const enum) ([A-Za-z0-9_]+)\b/;
  for (const file of sourceFiles(SRC_ROOT)) {
    for (const line of readFileSync(file, 'utf-8').split('\n')) {
      const match = declaration.exec(line);
      if (!match) continue;
      const list = byName.get(match[1]) ?? [];
      list.push(file);
      byName.set(match[1], list);
    }
  }
  return byName;
}

describe('exported type homonyms', () => {
  it('finds no exported type name declared twice outside the known-distinct set', () => {
    const duplicates = [...declarationsByName().entries()]
      .filter(([, files]) => files.length > 1)
      .map(([name]) => name)
      .filter((name) => !(name in KNOWN_DISTINCT_HOMONYMS))
      .sort();
    expect(duplicates).toEqual([]);
  });

  it('the known-distinct set carries no entry that has stopped being a homonym', () => {
    // Shrink-only in the other direction too: an allow-list entry whose second
    // declaration is gone would silently re-admit a future duplicate of that
    // name.
    const byName = declarationsByName();
    const stale = Object.keys(KNOWN_DISTINCT_HOMONYMS)
      .filter((name) => (byName.get(name)?.length ?? 0) < 2)
      .sort();
    expect(stale).toEqual([]);
  });

  it('detects a duplicate it is given', () => {
    // The positive control. The scan above returning an empty list is only
    // evidence when the matcher can produce a non-empty one.
    const declaration = /^export (?:type|interface|enum|const enum) ([A-Za-z0-9_]+)\b/;
    expect(declaration.exec('export type Foo = string;')?.[1]).toBe('Foo');
    expect(declaration.exec('export interface Foo {')?.[1]).toBe('Foo');
    // And a re-export is not a declaration, which is what the fix relies on.
    expect(declaration.exec('export type { Foo };')).toBeNull();
  });
});

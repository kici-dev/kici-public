/**
 * Instance index — a reconciled CACHE of all installed instances on the host.
 *
 * Lives at <kiciRoot>/instances.json, where kiciRoot is the name-agnostic
 * config root (~/.config/kici/ for user-level, /etc/kici/ for system). The
 * index is convenience: discovery is authoritative against the init system
 * (see resolve.ts#listInstances which reconciles this file against scans).
 *
 * Corrupt index → warn and treat as empty; the next install/uninstall
 * rewrites it cleanly.
 */

import fs from 'node:fs';
import path from 'node:path';
import type { Component, IndexEntry } from './types.js';

const FILE = 'instances.json';

/** Resolve <kiciRoot>/instances.json. */
export function indexPath(kiciRoot: string): string {
  return path.join(kiciRoot, FILE);
}

/** Read the index. Missing or corrupt → []. */
export function readIndex(kiciRoot: string): IndexEntry[] {
  const file = indexPath(kiciRoot);
  if (!fs.existsSync(file)) return [];
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf-8'));
    if (!Array.isArray(parsed)) {
      console.warn(`[kici] instance index at ${file} is invalid (not an array); ignoring`);
      return [];
    }
    return parsed as IndexEntry[];
  } catch (err) {
    console.warn(
      `[kici] instance index at ${file} is corrupt (${(err as Error).message}); ignoring`,
    );
    return [];
  }
}

/** Overwrite the index. */
export function writeIndex(kiciRoot: string, entries: IndexEntry[]): void {
  fs.mkdirSync(kiciRoot, { recursive: true });
  fs.writeFileSync(indexPath(kiciRoot), JSON.stringify(entries, null, 2) + '\n', 'utf-8');
}

/**
 * Append an entry. Idempotent for an exact (component,name,instanceDir) match.
 * Throws on a (component,name) collision with a different instanceDir — the
 * caller must use a different name or pass --force to overwrite.
 */
export function appendIndexEntry(kiciRoot: string, entry: IndexEntry): void {
  const current = readIndex(kiciRoot);
  const existing = current.find((e) => e.component === entry.component && e.name === entry.name);
  if (existing) {
    if (existing.instanceDir === entry.instanceDir) return; // idempotent
    throw new Error(
      `Already an ${entry.component} instance "${entry.name}" registered at ${existing.instanceDir}`,
    );
  }
  writeIndex(kiciRoot, [...current, entry]);
}

/** Remove the matching entry (no-op when absent). */
export function removeIndexEntry(
  kiciRoot: string,
  key: { component: Component; name: string },
): void {
  const current = readIndex(kiciRoot);
  const next = current.filter((e) => !(e.component === key.component && e.name === key.name));
  if (next.length !== current.length) writeIndex(kiciRoot, next);
}

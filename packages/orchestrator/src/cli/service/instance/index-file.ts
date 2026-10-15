/**
 * `<kiciRoot>/instances.json`: a reconciled CACHE of the host's installed
 * instances. Discovery against the init system is authoritative
 * (resolve.ts#listInstances reconciles this file against scans). A corrupt
 * index warns and reads as empty; the next install/uninstall rewrites it.
 */

import fs from 'node:fs';
import path from 'node:path';
import type { Component, IndexEntry } from './types.js';

const FILE = 'instances.json';

export function indexPath(kiciRoot: string): string {
  return path.join(kiciRoot, FILE);
}

/** Missing or corrupt → []. */
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

export function writeIndex(kiciRoot: string, entries: IndexEntry[]): void {
  fs.mkdirSync(kiciRoot, { recursive: true });
  fs.writeFileSync(indexPath(kiciRoot), JSON.stringify(entries, null, 2) + '\n', 'utf-8');
}

/**
 * Idempotent for an exact (component,name,instanceDir) match. Throws on a
 * (component,name) collision at another instanceDir: the caller picks another
 * name or passes --force.
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

/** No-op when absent. */
export function removeIndexEntry(
  kiciRoot: string,
  key: { component: Component; name: string },
): void {
  const current = readIndex(kiciRoot);
  const next = current.filter((e) => !(e.component === key.component && e.name === key.name));
  if (next.length !== current.length) writeIndex(kiciRoot, next);
}

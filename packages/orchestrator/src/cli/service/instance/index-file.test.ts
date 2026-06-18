import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  appendIndexEntry,
  indexPath,
  readIndex,
  removeIndexEntry,
  writeIndex,
} from './index-file.js';
import type { IndexEntry } from './types.js';

function entry(overrides: Partial<IndexEntry> = {}): IndexEntry {
  return {
    component: 'orchestrator',
    name: 'kici-test',
    platform: 'systemd',
    isUserLevel: true,
    instanceDir: '/x/y/',
    ...overrides,
  };
}

describe('index-file', () => {
  it('indexPath is <kiciRoot>/instances.json', () => {
    expect(indexPath('/etc/kici/')).toBe('/etc/kici/instances.json');
    expect(indexPath('/home/u/.config/kici/')).toBe('/home/u/.config/kici/instances.json');
  });

  it('readIndex returns [] when missing', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kici-idx-'));
    try {
      expect(readIndex(root)).toEqual([]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('writeIndex then readIndex round-trips', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kici-idx-'));
    try {
      const a = entry({ name: 'a' });
      const b = entry({ name: 'b', component: 'agent' });
      writeIndex(root, [a, b]);
      expect(readIndex(root)).toEqual([a, b]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('appendIndexEntry adds a new entry idempotently', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kici-idx-'));
    try {
      const e = entry();
      appendIndexEntry(root, e);
      appendIndexEntry(root, e); // idempotent: same component+name+instanceDir
      expect(readIndex(root)).toEqual([e]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('appendIndexEntry rejects a same-name-different-dir collision', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kici-idx-'));
    try {
      appendIndexEntry(root, entry({ instanceDir: '/dir-1/' }));
      expect(() => appendIndexEntry(root, entry({ instanceDir: '/dir-2/' }))).toThrow(
        /already.*instance.*kici-test/i,
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('removeIndexEntry drops a matching entry, no-op when absent', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kici-idx-'));
    try {
      const a = entry({ name: 'a' });
      const b = entry({ name: 'b' });
      writeIndex(root, [a, b]);
      removeIndexEntry(root, { component: 'orchestrator', name: 'a' });
      expect(readIndex(root)).toEqual([b]);
      // no-op on missing
      removeIndexEntry(root, { component: 'orchestrator', name: 'missing' });
      expect(readIndex(root)).toEqual([b]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('readIndex tolerates a corrupt file (returns [] and warns once)', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kici-idx-'));
    try {
      fs.writeFileSync(path.join(root, 'instances.json'), 'not json at all');
      const warns: string[] = [];
      const orig = console.warn;
      console.warn = (msg: string) => warns.push(String(msg));
      try {
        expect(readIndex(root)).toEqual([]);
        expect(warns.some((w) => /corrupt|invalid/i.test(w))).toBe(true);
      } finally {
        console.warn = orig;
      }
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

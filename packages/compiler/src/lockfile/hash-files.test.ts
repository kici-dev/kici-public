import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { resolveHashFiles } from './hash-files.js';

let tempDir: string;

beforeAll(() => {
  tempDir = mkdtempSync(path.join(tmpdir(), 'kici-hash-files-'));
});

afterAll(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

describe('resolveHashFiles', () => {
  it('returns null for empty patterns', () => {
    expect(resolveHashFiles(tempDir, [])).toBeNull();
  });

  it('resolves a single file and returns digest and paths', () => {
    const filePath = path.join(tempDir, 'config.json');
    writeFileSync(filePath, '{"env":"test"}', 'utf-8');
    const result = resolveHashFiles(tempDir, ['config.json']);
    expect(result).not.toBeNull();
    expect(result!.resolvedPaths).toEqual(['config.json']);
    expect(result!.assetDigest).toContain('config.json');
    expect(result!.assetDigest).toContain('{"env":"test"}');
  });

  it('resolves glob and sorts paths deterministically', () => {
    writeFileSync(path.join(tempDir, 'a.txt'), 'a', 'utf-8');
    writeFileSync(path.join(tempDir, 'b.txt'), 'b', 'utf-8');
    const result = resolveHashFiles(tempDir, ['*.txt']);
    expect(result).not.toBeNull();
    expect(result!.resolvedPaths.sort()).toEqual(['a.txt', 'b.txt']);
    expect(result!.assetDigest).toMatch(/a\.txt\na/);
    expect(result!.assetDigest).toMatch(/b\.txt\nb/);
  });

  it('omits missing files from resolved paths and digest', () => {
    const result = resolveHashFiles(tempDir, ['nonexistent.txt']);
    expect(result).not.toBeNull();
    expect(result!.resolvedPaths).toEqual([]);
    expect(result!.assetDigest).toBe('');
  });

  it('deduplicates paths when multiple patterns match the same file', () => {
    writeFileSync(path.join(tempDir, 'single.txt'), 'x', 'utf-8');
    const result = resolveHashFiles(tempDir, ['single.txt', 'single.txt', 'sin*.txt']);
    expect(result!.resolvedPaths).toEqual(['single.txt']);
  });
});

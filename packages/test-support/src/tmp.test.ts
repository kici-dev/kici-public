import { existsSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { cleanupTestTempDirs, makeTempDir, TEST_TMP_DIR_NAME, TEST_TMP_ROOT } from './tmp.js';

describe('TEST_TMP_ROOT', () => {
  it('is the one parent every tree lands under', () => {
    expect(TEST_TMP_ROOT).toBe(path.join(tmpdir(), TEST_TMP_DIR_NAME));
    expect(TEST_TMP_DIR_NAME).toBe('kici-test');
  });

  it('places the tree inside the parent, keeping the readable prefix', () => {
    const dir = makeTempDir('tt-readable-');
    expect(path.dirname(dir)).toBe(TEST_TMP_ROOT);
    expect(path.basename(dir).startsWith('tt-readable-')).toBe(true);
    expect(existsSync(dir)).toBe(true);
  });

  it('hands out a distinct tree per call for the same prefix', () => {
    const dirs = [
      makeTempDir('tt-distinct-'),
      makeTempDir('tt-distinct-'),
      makeTempDir('tt-distinct-'),
    ];
    expect(new Set(dirs).size).toBe(3);
    for (const dir of dirs) expect(existsSync(dir)).toBe(true);
  });

  it('rejects a prefix that would escape the parent', () => {
    expect(() => makeTempDir('../escape-')).toThrow(/single path segment/);
    expect(() => makeTempDir('nested/escape-')).toThrow(/single path segment/);
    expect(() => makeTempDir('')).toThrow(/must not be empty/);
  });
});

describe('cleanup after the test that created the tree', () => {
  let fromPassingTest = '';
  let fromFailingTest = '';

  it('creates a tree in a passing test', () => {
    fromPassingTest = makeTempDir('tt-passing-');
    writeFileSync(path.join(fromPassingTest, 'f.txt'), 'x');
    expect(existsSync(fromPassingTest)).toBe(true);
  });

  it('removed the passing test tree once that test finished', () => {
    expect(fromPassingTest).not.toBe('');
    expect(existsSync(fromPassingTest)).toBe(false);
  });

  it.fails('creates a tree in a test that then throws', () => {
    fromFailingTest = makeTempDir('tt-throwing-');
    expect(existsSync(fromFailingTest)).toBe(true);
    throw new Error('deliberate failure — the tree must still be removed');
  });

  it('removed the throwing test tree too', () => {
    expect(fromFailingTest).not.toBe('');
    expect(existsSync(fromFailingTest)).toBe(false);
  });
});

describe('cleanup outside a test context', () => {
  let fromBeforeAll = '';

  beforeAll(() => {
    fromBeforeAll = makeTempDir('tt-before-all-');
    writeFileSync(path.join(fromBeforeAll, 'f.txt'), 'x');
  });

  afterAll(() => {
    // `beforeAll` has no test to attach to, so the tree survives every test in
    // this suite. What removes it is `cleanupTestTempDirs`, which the setup
    // file runs in its own `afterAll` — called directly here to assert it.
    expect(existsSync(fromBeforeAll)).toBe(true);
    cleanupTestTempDirs();
    expect(existsSync(fromBeforeAll)).toBe(false);
  });

  it('survives the tests that use it', () => {
    expect(readdirSync(fromBeforeAll)).toEqual(['f.txt']);
  });
});

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import * as engine from '@kici-dev/engine';
import * as compilerTypes from './types.js';

describe('compiler Lock* types', () => {
  const src = readFileSync(path.join(import.meta.dirname, 'types.ts'), 'utf8');

  // control: the scan reads the file and the anchored multiline form matches a
  // declaration the file does own, so an empty result below is not vacuous
  it('sees the compiler-owned declarations', () => {
    expect(src.match(/^export interface \w+/gm)).toEqual([
      'export interface WorkflowSourceInfo',
      'export interface WorkflowWithSource',
    ]);
  });

  // fails-when: a Lock* interface or type is redeclared in the compiler instead of re-exported from engine
  it('declares no Lock* type of its own', () => {
    expect(src.match(/^export (interface|type) Lock\w+/gm) ?? []).toEqual([]);
  });

  // Identity cannot tell a copied primitive from the engine one, so the
  // constants are pinned at the source level.
  // fails-when: the compiler declares `export const SCHEMA_VERSION = …` or `BREAKING_FLOOR` itself
  it('declares no schema constant or lock guard of its own', () => {
    expect(
      src.match(/^export (const|let|function) (SCHEMA_VERSION|BREAKING_FLOOR|isLock\w+)/gm) ?? [],
    ).toEqual([]);
  });

  // fails-when: the compiler defines its own lock guard instead of the engine one
  it('re-exports the engine runtime values by identity', () => {
    expect(compilerTypes.SCHEMA_VERSION).toBe(engine.SCHEMA_VERSION);
    expect(compilerTypes.BREAKING_FLOOR).toBe(engine.BREAKING_FLOOR);
    expect(compilerTypes.isLockParallelStep).toBe(engine.isLockParallelStep);
    expect(compilerTypes.isLockStaticJob).toBe(engine.isLockStaticJob);
    expect(compilerTypes.isLockDynamicJobFn).toBe(engine.isLockDynamicJobFn);
  });
});

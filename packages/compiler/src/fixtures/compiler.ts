/**
 * Fixture auto-compilation pipeline.
 *
 * Discovers and dynamic-imports Fixture exports from `.kici/tests/*.ts` files.
 * TypeScript transformation is handled by the `@kici-dev/core/ts-loader-hook`
 * oxc-transform ESM loader hook, registered lazily via `ensureTsLoaderHook()`
 * before the dynamic import (the same hook the agent registers). Fixture files
 * are imported in
 * place so Node resolves `@kici-dev/sdk` from the customer's
 * `.kici/node_modules/` — no temp files, no Rolldown bundle step.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { Fixture, FixtureOptions } from '@kici-dev/sdk';
import picomatch from 'picomatch';
import { ensureTsLoaderHook } from '../execution/ts-loader.js';

/** A compiled fixture with source tracking */
export interface CompiledFixture {
  /** Fixture ID */
  id: string;
  /** Absolute path to the source file */
  sourceFile: string;
  /** Resolved fixture definition */
  fixture: Fixture;
}

/**
 * Discover fixture files in the tests directory.
 *
 * Scans recursively for `*.ts` files.
 * Returns empty array if directory doesn't exist (not an error).
 */
export async function discoverFixtureFiles(testsDir: string): Promise<string[]> {
  const absoluteDir = path.resolve(testsDir);

  try {
    const stat = await fs.stat(absoluteDir);
    if (!stat.isDirectory()) {
      return [];
    }
  } catch {
    return [];
  }

  const files = await scanDirectory(absoluteDir);
  return files.sort();
}

async function scanDirectory(dir: string): Promise<string[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const results: string[] = [];

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const nested = await scanDirectory(fullPath);
      results.push(...nested);
    } else if (entry.isFile() && entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) {
      results.push(fullPath);
    }
  }

  return results;
}

/**
 * Compile and extract fixtures from all `.kici/tests/*.ts` files.
 *
 * Process:
 * 1. Discover fixture files.
 * 2. Dynamic-import each `.ts` file (transformed on the fly by the
 *    `@kici-dev/core/ts-loader-hook` oxc-transform ESM loader hook, registered
 *    lazily via `ensureTsLoaderHook()`).
 * 3. Extract Fixture exports.
 * 4. Resolve async factory fixtures.
 * 5. Validate no duplicate fixture IDs.
 */
export async function compileFixtures(testsDir: string): Promise<CompiledFixture[]> {
  const files = await discoverFixtureFiles(testsDir);
  if (files.length === 0) {
    return [];
  }

  const allFixtures: CompiledFixture[] = [];
  for (const file of files) {
    const fixtures = await loadFixtureFile(file);
    allFixtures.push(...fixtures);
  }

  const seenIds = new Map<string, string>();
  for (const cf of allFixtures) {
    const existing = seenIds.get(cf.id);
    if (existing) {
      throw new Error(
        `Duplicate fixture ID "${cf.id}" found in:\n  - ${existing}\n  - ${cf.sourceFile}`,
      );
    }
    seenIds.set(cf.id, cf.sourceFile);
  }

  return allFixtures;
}

async function loadFixtureFile(filePath: string): Promise<CompiledFixture[]> {
  // If the fixture file's ancestor tree doesn't provide a node_modules/ with
  // the critical runtime packages (@kici-dev/sdk, zx, @kici-dev/shared), link
  // them in from the compiler's install location. In a normal customer repo
  // `.kici/node_modules/` is populated by `kici compile` and this is a no-op;
  // the fallback is here so test setups (and one-off fixture files dropped in
  // a fresh temp dir) don't need to hand-wire a symlink farm.
  const createdLinks = await ensureRuntimeSymlinks(filePath);

  let mod: Record<string, unknown>;
  try {
    ensureTsLoaderHook();
    const moduleUrl = pathToFileURL(filePath).href;
    const cacheBuster = `?t=${Date.now()}`;
    mod = (await import(moduleUrl + cacheBuster)) as Record<string, unknown>;
  } catch (err) {
    throw new Error(`Failed to load fixture module ${filePath}: ${(err as Error).message}`);
  } finally {
    for (const link of createdLinks.reverse()) {
      await fs.rm(link, { recursive: true, force: true }).catch(() => {});
    }
  }

  const fixtures: CompiledFixture[] = [];
  for (const [key, value] of Object.entries(mod)) {
    if (key === 'default') continue;
    if (isFixture(value)) {
      const resolved = await resolveFixture(value);
      fixtures.push({
        id: resolved.id,
        sourceFile: filePath,
        fixture: resolved,
      });
    }
  }

  return fixtures;
}

const RUNTIME_PACKAGES = ['@kici-dev/sdk', 'zx', '@kici-dev/core'] as const;

async function ensureRuntimeSymlinks(filePath: string): Promise<string[]> {
  const created: string[] = [];
  let nodeModulesDir = await findNearestNodeModules(path.dirname(filePath));
  if (!nodeModulesDir) {
    nodeModulesDir = path.join(path.dirname(filePath), 'node_modules');
    await fs.mkdir(nodeModulesDir, { recursive: true });
    created.push(nodeModulesDir);
  }
  for (const pkg of RUNTIME_PACKAGES) {
    const linkPath = path.join(nodeModulesDir, pkg);
    try {
      await fs.access(linkPath);
      continue;
    } catch {
      // needs linking
    }
    try {
      const entry = import.meta.resolve(pkg);
      const pkgDir = await findPackageRoot(fileURLToPath(entry));
      const linkParent = path.dirname(linkPath);
      if (linkParent !== nodeModulesDir) {
        await fs.mkdir(linkParent, { recursive: true });
      }
      await fs.symlink(pkgDir, linkPath);
      created.push(linkPath);
    } catch {
      // Package isn't resolvable from the compiler — skip; import() will
      // surface the real error if the fixture actually needs this package.
    }
  }
  return created;
}

async function findNearestNodeModules(startDir: string): Promise<string | undefined> {
  let dir = startDir;
  while (dir !== path.dirname(dir)) {
    const nm = path.join(dir, 'node_modules');
    try {
      const stat = await fs.stat(nm);
      if (stat.isDirectory()) return nm;
    } catch {
      // continue walking
    }
    dir = path.dirname(dir);
  }
  return undefined;
}

async function findPackageRoot(filePath: string): Promise<string> {
  let dir = path.dirname(filePath);
  while (dir !== path.dirname(dir)) {
    try {
      await fs.access(path.join(dir, 'package.json'));
      return dir;
    } catch {
      dir = path.dirname(dir);
    }
  }
  return path.dirname(filePath);
}

function isFixture(value: unknown): value is Fixture {
  if (typeof value !== 'object' || value === null) return false;
  const obj = value as Record<string, unknown>;
  return (
    typeof obj.id === 'string' &&
    obj.id.length > 0 &&
    (typeof obj.options === 'object' || typeof obj.options === 'function') &&
    obj.options !== null
  );
}

async function resolveFixture(fixture: Fixture): Promise<Fixture> {
  if (typeof fixture.options === 'function') {
    const resolved = await fixture.options();
    return Object.freeze({
      id: fixture.id,
      options: Object.freeze(resolved) as FixtureOptions,
    });
  }
  return fixture;
}

/**
 * Filter compiled fixtures by pattern.
 *
 * - Exact match on fixture ID
 * - Glob pattern matching via picomatch
 */
export function filterFixtures(fixtures: CompiledFixture[], pattern: string): CompiledFixture[] {
  const exact = fixtures.find((f) => f.id === pattern);
  if (exact) {
    return [exact];
  }

  const isMatch = picomatch(pattern);
  return fixtures.filter((f) => isMatch(f.id)).sort((a, b) => a.id.localeCompare(b.id));
}

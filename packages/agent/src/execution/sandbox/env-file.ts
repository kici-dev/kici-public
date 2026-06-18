/**
 * KICI_ENV / KICI_PATH temp-file contract.
 *
 * Before each step the agent points the KICI_ENV and KICI_PATH env vars at fresh
 * temp files. A step's shell commands append `KEY=value` lines to $KICI_ENV and
 * one directory per line to $KICI_PATH. After the step the agent parses both
 * files into an EnvDelta and feeds it through applyEnvDelta() -- the same path
 * the JS API (ctx.setEnv / ctx.addPath) uses -- then truncates the files for the
 * next step.
 *
 * Format v1: single-line `KEY=value` for env (no embedded newlines); one
 * directory per line for path. Blank lines and lines without `=` are ignored.
 */

import { mkdtemp, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { EnvDelta } from './env-delta.js';

/** The pair of temp files the step's shell appends to. */
export interface EnvFiles {
  /** Path of the file steps append `KEY=value` lines to (KICI_ENV). */
  envFile: string;
  /** Path of the file steps append one directory per line to (KICI_PATH). */
  pathFile: string;
}

/**
 * Parse `KEY=value` lines into a record. Blank lines, lines without `=`, and
 * lines with an empty key are ignored. The split is on the first `=` only, so a
 * value may contain `=`. The key is trimmed; the value is taken verbatim after
 * the first `=`. Last assignment to a key wins.
 */
export function parseEnvFileContent(content: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rawLine of content.split('\n')) {
    const line = rawLine.trim();
    if (line.length === 0) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue; // no `=`, or empty key
    const key = line.slice(0, eq).trim();
    if (key.length === 0) continue;
    out[key] = line.slice(eq + 1);
  }
  return out;
}

/** Parse one trimmed directory per non-blank line, preserving order. */
export function parsePathFileContent(content: string): string[] {
  const out: string[] = [];
  for (const rawLine of content.split('\n')) {
    const line = rawLine.trim();
    if (line.length === 0) continue;
    out.push(line);
  }
  return out;
}

/** Create fresh, empty env + path files inside a private temp dir under `baseDir`. */
export async function createEnvFiles(baseDir: string): Promise<EnvFiles> {
  const dir = await mkdtemp(join(baseDir, 'kici-env-'));
  const envFile = join(dir, 'env');
  const pathFile = join(dir, 'path');
  await writeFile(envFile, '');
  await writeFile(pathFile, '');
  return { envFile, pathFile };
}

/** Convenience: create env files under the OS temp dir. */
export function createEnvFilesInTmp(): Promise<EnvFiles> {
  return createEnvFiles(tmpdir());
}

/** Read + parse both files into an EnvDelta. Missing/empty files yield an empty delta. */
export async function readEnvDelta(files: EnvFiles): Promise<EnvDelta> {
  const [envContent, pathContent] = await Promise.all([
    readFile(files.envFile, 'utf8').catch(() => ''),
    readFile(files.pathFile, 'utf8').catch(() => ''),
  ]);
  return {
    env: parseEnvFileContent(envContent),
    pathPrepends: parsePathFileContent(pathContent),
  };
}

/** Truncate both files to empty so the next step starts clean. */
export async function truncateEnvFiles(files: EnvFiles): Promise<void> {
  await Promise.all([writeFile(files.envFile, ''), writeFile(files.pathFile, '')]);
}

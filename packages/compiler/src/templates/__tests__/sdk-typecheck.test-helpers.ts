/**
 * Type-check generated TypeScript against the workspace SDK source, for the
 * scaffold template tests.
 */

import { mkdirSync, mkdtempSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const here = dirname(fileURLToPath(import.meta.url));
// __tests__ -> templates -> src -> compiler -> packages
const repoRoot = resolve(here, '../../../../..');
const sdkEntry = resolve(repoRoot, 'packages/sdk/src/index.ts');

/** A fresh directory under the repo's `node_modules/.cache` for generated sources. */
export function makeSdkTypecheckDir(prefix: string): string {
  const cacheRoot = resolve(repoRoot, 'node_modules/.cache');
  mkdirSync(cacheRoot, { recursive: true });
  return mkdtempSync(resolve(cacheRoot, prefix));
}

function renderDiagnostic(d: ts.Diagnostic): string {
  const message = ts.flattenDiagnosticMessageText(d.messageText, '\n');
  if (d.file && d.start !== undefined) {
    const { line, character } = d.file.getLineAndCharacterOfPosition(d.start);
    return `${d.file.fileName}:${line + 1}:${character + 1} — ${message}`;
  }
  return message;
}

/**
 * Type-check `files` with `@kici-dev/sdk` resolved to the workspace source, and
 * return the diagnostics located in those files, one rendered line each.
 */
export function typecheckAgainstSdk(files: string[]): string[] {
  const options: ts.CompilerOptions = {
    target: ts.ScriptTarget.ES2024,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    strict: true,
    esModuleInterop: true,
    skipLibCheck: true,
    noEmit: true,
    baseUrl: repoRoot,
    paths: { '@kici-dev/sdk': [sdkEntry] },
  };
  const program = ts.createProgram(files, options);
  const fileSet = new Set(files.map((f) => resolve(f)));
  return ts
    .getPreEmitDiagnostics(program)
    .filter((d) => d.file !== undefined && fileSet.has(resolve(d.file.fileName)))
    .map(renderDiagnostic);
}

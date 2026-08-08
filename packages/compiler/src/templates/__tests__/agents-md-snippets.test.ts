import { afterAll, describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import ts from 'typescript';
import { agentsMdTemplate } from '../agents-md.js';

const here = dirname(fileURLToPath(import.meta.url));
// __tests__ -> templates -> src -> compiler -> packages
const repoRoot = resolve(here, '../../../../..');
const sdkEntry = resolve(repoRoot, 'packages/sdk/src/index.ts');
const cacheRoot = resolve(repoRoot, 'node_modules/.cache');

/** Fixed preamble prepended to fragment snippets so their SDK identifiers resolve. */
const FRAGMENT_PREAMBLE = "import { workflow, job, step, pr, push } from '@kici-dev/sdk';\n";

/** Extract every fenced ```ts block from the template (indent-tolerant, multiline). */
function extractTsSnippets(markdown: string): string[] {
  const fence = /^[ \t]*```ts[ \t]*\r?\n([\s\S]*?)^[ \t]*```[ \t]*$/gm;
  const snippets: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = fence.exec(markdown)) !== null) {
    snippets.push(match[1]);
  }
  return snippets;
}

/** A snippet is a complete module iff it imports from @kici-dev/sdk. */
function isModuleSnippet(snippet: string): boolean {
  return /\bimport\b[\s\S]*?from\s+['"]@kici-dev\/sdk['"]/.test(snippet);
}

/** Write each snippet (fragments get the preamble) to a temp .ts file; return their paths. */
function writeSnippetFiles(dir: string, snippets: string[]): string[] {
  return snippets.map((snippet, i) => {
    const source = isModuleSnippet(snippet) ? snippet : FRAGMENT_PREAMBLE + snippet;
    const file = resolve(dir, `snippet-${i}.ts`);
    writeFileSync(file, source, 'utf-8');
    return file;
  });
}

/** Type-check the snippet files against the workspace SDK source; return snippet-scoped diagnostics. */
function typecheckSnippets(files: string[]): ts.Diagnostic[] {
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
    .filter((d) => d.file !== undefined && fileSet.has(resolve(d.file.fileName)));
}

/** Human-readable rendering of a diagnostic for the failure message. */
function renderDiagnostic(d: ts.Diagnostic): string {
  const message = ts.flattenDiagnosticMessageText(d.messageText, '\n');
  if (d.file && d.start !== undefined) {
    const { line, character } = d.file.getLineAndCharacterOfPosition(d.start);
    return `${d.file.fileName}:${line + 1}:${character + 1} — ${message}`;
  }
  return message;
}

mkdirSync(cacheRoot, { recursive: true });
const tmpDir = mkdtempSync(resolve(cacheRoot, 'kici-agents-md-'));

afterAll(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('agents-md template snippets', () => {
  const snippets = extractTsSnippets(agentsMdTemplate);

  it('extracts at least the push, matrix, and secrets snippets', () => {
    expect(snippets.length).toBeGreaterThanOrEqual(3);
  });

  // Builds a real TypeScript program over the whole SDK source tree, so it is
  // CPU-bound: ~5s standalone, but well past the package-wide 15s testTimeout
  // when the full 110-file suite saturates every vitest worker. Budget it
  // explicitly rather than letting suite parallelism decide whether it passes.
  it('every ts snippet type-checks against the real @kici-dev/sdk', () => {
    const files = writeSnippetFiles(tmpDir, snippets);
    const diagnostics = typecheckSnippets(files);
    const rendered = diagnostics.map(renderDiagnostic).join('\n');
    expect(rendered, `Template snippet(s) failed type-check:\n${rendered}`).toBe('');
  }, 120_000);
});

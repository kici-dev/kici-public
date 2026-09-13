/**
 * Runtime backstop for the KICI_ env-var allowlist.
 *
 * Walks the source tree under `packages/`, `scripts/`, and `e2e/` and
 * matches every `process.env.NAME` and `process.env['NAME']` access
 * against `IS_ALLOWED_ENV_NAME(NAME)` from `./allowlist.ts`. Any
 * unmatched name fails the test with a clear error pointing at the file
 * and the offending name.
 *
 * Why a backstop? The compile-time enforcement is the inline
 * `no-restricted-syntax` rule in `eslint.config.js`. Two failure modes
 * the runtime walk catches that ESLint can miss:
 *
 *   - Template-literal indexing: `process.env[`FOO_${suffix}`]` produces
 *     a TemplateLiteral expression, which the static `Literal`-based
 *     selector cannot pattern-match at lint time.
 *   - Whatever future contributor decides to disable the lint rule
 *     file-wide. The backstop walks the tree regardless of disable
 *     comments.
 *
 * Modeled on the dep-graph walker in
 * `packages/platform/src/admin/actor-factory.test.ts`. Same shape:
 * recursive directory walk, ignore node_modules / dist / *.test.ts,
 * collect violations, expect [] at the end.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve, relative } from 'node:path';
import { IS_ALLOWED_ENV_NAME } from './allowlist.js';

/** Repo root, three `..` up from `packages/shared/src/env/`. */
const REPO_ROOT = resolve(import.meta.dirname, '../../../../');

/**
 * Roots of the source tree that the backstop walks. Mirrors the
 * coverage area of the inline ESLint rule. We deliberately exclude
 * `docs-site/`, `infra/`, and `tools/` because they sit on the edges
 * of the project and currently contain a few legitimate non-KICI_ env
 * reads (Astro/Vite/etc.) that are scoped to their own subtrees. They
 * can be added in a later sweep.
 */
const SCAN_ROOTS = ['packages', 'scripts', 'e2e'];

/**
 * Files / directories the walker skips outright. `allowlist.ts` and
 * this test file are excluded because their JSDoc and test-fixture
 * blocks contain the literal pattern `process.env.NAME` for
 * documentation purposes (e.g. the example in this very paragraph).
 */
const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', '.cache', 'coverage', '.git']);
const SELF_FILES = new Set([
  resolve(import.meta.dirname, 'allowlist.ts'),
  resolve(import.meta.dirname, 'env-rule-allowlist.test.ts'),
]);

/** File-extension allowlist — matches the inline ESLint rule's `files` glob. */
const SOURCE_EXTS = /\.(ts|tsx|mts|mjs|js|cjs)$/;

/**
 * Test files are excluded from the walk for the same reason the inline
 * ESLint rule should exclude them: tests legitimately set/read arbitrary
 * env names to exercise sanitizer / expose / fixture code paths
 * (`process.env.RANDOM_VAR`, `process.env.WEBHOOK_SECRET`, etc.).
 * Forcing every fixture name into `MIGRATING_ENV_VARS` would defeat
 * the purpose of the allowlist.
 */
const TEST_FILE = /\.(test|spec|int\.test)\.(ts|tsx|mts|mjs|js|cjs)$/;

function walk(dir: string, out: string[] = []): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of entries) {
    if (SKIP_DIRS.has(name)) continue;
    const full = join(dir, name);
    let stat;
    try {
      stat = statSync(full);
    } catch {
      continue;
    }
    if (stat.isDirectory()) {
      walk(full, out);
    } else if (stat.isFile() && SOURCE_EXTS.test(name) && !TEST_FILE.test(name)) {
      if (SELF_FILES.has(full)) continue;
      out.push(full);
    }
  }
  return out;
}

/**
 * Single regex that catches both forms in one pass:
 *   - `process.env.NAME`         — dot member access.
 *   - `process.env['NAME']`      — single-quoted computed access.
 *   - `process.env["NAME"]`      — double-quoted computed access.
 *
 * The capture group is the env-var name. `[A-Z_][A-Z0-9_]*` matches the
 * shouty SCREAMING_SNAKE convention; lowercase identifiers (npm_*,
 * UTF8 strings, etc.) won't match here, but the `npm_*` family is
 * already in the OS/SDK regex anyway and isn't accessed via this
 * pattern in our source tree.
 */
const ACCESS_RE = /process\.env(?:\.([A-Z_][A-Z0-9_]*)|\[['"]([A-Z_][A-Z0-9_]*)['"]\])/g;

/**
 * Strip the contents of every backtick-bounded template literal before
 * scanning, while preserving line counts so violation line numbers stay
 * accurate. Template literals frequently embed workflow source code that
 * the host file emits to disk (`ensureInternalSecretsWorkflow`,
 * `ensureInternalDynamicEnvWorkflow`, etc.) — those `process.env.NAME`
 * occurrences belong to the *generated* file, not to the host, so they
 * must not trigger the allowlist check here.
 *
 * The replacement keeps each newline intact so that `upTo.split('\n').length`
 * elsewhere still reports the correct line. We approximate "template
 * literal" with `` ` … ` `` matching, treating `\\.` as an escape (so
 * `` \` `` does not close the literal). This is a deliberate string-level
 * approximation rather than full TS AST parsing — the latter would buy
 * us nothing because the only construct we need to ignore is the
 * literal contents of fixture-emitting backtick strings, and the regex
 * gets that right for every host file in the tree.
 */
function stripTemplateLiteralContents(src: string): string {
  return src.replace(/`(?:\\.|[^\\`])*`/g, (match) => {
    // Replace the literal body with whitespace so the regex below can't
    // match `process.env.NAME` inside it. Preserve newlines so line
    // numbers in error messages still point at the correct host-file
    // line. The backticks themselves are kept too, just to keep the
    // shape of the source visually similar.
    let out = '`';
    for (let i = 1; i < match.length - 1; i++) {
      out += match[i] === '\n' ? '\n' : ' ';
    }
    out += '`';
    return out;
  });
}

interface Violation {
  file: string;
  name: string;
  line: number;
}

function scanFile(file: string): Violation[] {
  let src: string;
  try {
    src = readFileSync(file, 'utf-8');
  } catch {
    return [];
  }
  // Strip template-literal contents first so that `process.env.NAME`
  // occurrences embedded in workflow-source-code fixtures (emitted to
  // disk by helpers like `ensureInternalDynamicEnvWorkflow`) do not
  // get attributed to the host file. Newlines inside the literal are
  // preserved so violation line numbers stay accurate.
  const scrubbed = stripTemplateLiteralContents(src);
  const violations: Violation[] = [];
  // Reset per-file because the regex is `g`-flagged and shared.
  ACCESS_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = ACCESS_RE.exec(scrubbed)) !== null) {
    const name = m[1] ?? m[2];
    if (!name) continue;
    if (IS_ALLOWED_ENV_NAME(name)) continue;
    // Compute 1-indexed line number for the match start.
    const upTo = scrubbed.slice(0, m.index);
    const line = upTo.split('\n').length;
    violations.push({ file, name, line });
  }
  return violations;
}

describe('env-var allowlist (filesystem walk)', () => {
  it('every process.env access matches the allowlist or MIGRATING_ENV_VARS', () => {
    const files: string[] = [];
    for (const root of SCAN_ROOTS) {
      walk(resolve(REPO_ROOT, root), files);
    }
    expect(files.length).toBeGreaterThan(0);

    const violations: Violation[] = [];
    for (const file of files) {
      violations.push(...scanFile(file));
    }

    const formatted = violations
      .map((v) => `  ${relative(REPO_ROOT, v.file)}:${v.line}  process.env.${v.name}`)
      .join('\n');
    const message = `Found ${violations.length} unallowlisted process.env access(es). Either:\n  - rename the env var to KICI_* (preferred), or\n  - add it to MIGRATING_ENV_VARS in packages/shared/src/env/allowlist.ts\n    (and mirror in eslint.config.js inline regex), or\n  - extend OS_SDK_ALLOWLIST_REGEX if it is a genuine OS/SDK name.\n\nViolations:\n${formatted}`;
    expect(violations, message).toEqual([]);
  });
});

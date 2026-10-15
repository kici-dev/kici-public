/**
 * Runtime backstop for the KICI_ env-var allowlist: every `process.env.NAME` /
 * `process.env['NAME']` access under `SCAN_ROOTS` must pass
 * `IS_ALLOWED_ENV_NAME` from `./allowlist.ts`.
 *
 * The inline `no-restricted-syntax` rule in `eslint.config.js` is the
 * compile-time enforcement; this walk also catches what ESLint misses:
 * template-literal indexing (`process.env[`FOO_${suffix}`]`, which the
 * `Literal`-based selector cannot match) and files that disable the lint rule.
 */
import { describe, it, expect } from 'vitest';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, relative } from 'node:path';
import { IS_ALLOWED_ENV_NAME } from './allowlist.js';

const REPO_ROOT = resolve(import.meta.dirname, '../../../../');

/**
 * Mirrors the inline ESLint rule's coverage. `docs-site/`, `infra/` and
 * `tools/` are excluded: they hold legitimate non-KICI_ env reads
 * (Astro/Vite/etc.) scoped to their own subtrees.
 */
const SCAN_ROOTS = ['packages', 'scripts', 'e2e'];

const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', '.cache', 'coverage', '.git']);
/**
 * Gitignored `.tmp-*` scratch trees of rendered workflow templates, which read
 * arbitrary env names on purpose. One left behind by a killed run must not fail
 * an unrelated package's tests.
 */
const SCRATCH_DIR = /^\.tmp-/;
/** `allowlist.ts` and this file contain `process.env.NAME` as documentation. */
const SELF_FILES = new Set([
  resolve(import.meta.dirname, 'allowlist.ts'),
  resolve(import.meta.dirname, 'env-rule-allowlist.test.ts'),
]);

/** File-extension allowlist — matches the inline ESLint rule's `files` glob. */
const SOURCE_EXTS = /\.(ts|tsx|mts|mjs|js|cjs)$/;

/**
 * Test files are excluded: they read arbitrary env names to exercise
 * sanitizer / expose / fixture paths, and listing each in `MIGRATING_ENV_VARS`
 * would defeat the allowlist.
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
    if (SKIP_DIRS.has(name) || SCRATCH_DIR.test(name)) continue;
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
 * Matches `process.env.NAME`, `process.env['NAME']` and `process.env["NAME"]`.
 * Only SCREAMING_SNAKE names match; lowercase `npm_*` is in the OS/SDK regex
 * anyway and not read this way in the tree.
 */
const ACCESS_RE = /process\.env(?:\.([A-Z_][A-Z0-9_]*)|\[['"]([A-Z_][A-Z0-9_]*)['"]\])/g;

/**
 * Blank every template literal's body, keeping newlines so violation line
 * numbers stay accurate. Template literals often embed workflow source the host
 * file emits; their `process.env.NAME` belongs to the generated file.
 *
 * A string-level approximation (`\\.` is an escape, so `` \` `` does not close
 * the literal) rather than a TS AST parse, which would buy nothing: it handles
 * every host file in the tree.
 */
function stripTemplateLiteralContents(src: string): string {
  return src.replace(/`(?:\\.|[^\\`])*`/g, (match) => {
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
  const scrubbed = stripTemplateLiteralContents(src);
  const violations: Violation[] = [];
  // Reset per-file because the regex is `g`-flagged and shared.
  ACCESS_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = ACCESS_RE.exec(scrubbed)) !== null) {
    const name = m[1] ?? m[2];
    if (!name) continue;
    if (IS_ALLOWED_ENV_NAME(name)) continue;
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

  // fails-when: the walker descends into a `.tmp-*` tree — the probe file it
  // finds there reads an unallowlisted name, so it would surface as a violation.
  // breaks-if-wrong: a source file NEXT to the scratch tree must still be
  // walked, or the skip has silenced the whole root.
  it('skips gitignored .tmp-* scratch trees but still walks their siblings', () => {
    const root = mkdtempSync(join(tmpdir(), 'allowlist-walk-'));
    try {
      const scratch = join(root, '.tmp-template-check-probe');
      mkdirSync(scratch, { recursive: true });
      writeFileSync(join(scratch, 'fixture.ts'), 'process.env.NOT_ALLOWLISTED_PROBE;\n');
      writeFileSync(join(root, 'real.ts'), 'export const x = 1;\n');
      const files = walk(root);
      expect(files).toEqual([join(root, 'real.ts')]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

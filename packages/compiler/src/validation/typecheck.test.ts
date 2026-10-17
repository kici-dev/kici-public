import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { parseTscOutput, resolveLocalTsc, runTypecheck } from './typecheck.js';

describe('parseTscOutput', () => {
  it('maps a located tsc diagnostic line to a located E120 CompilerError', () => {
    const out =
      "workflows/ci.ts(12,5): error TS2322: Type 'number' is not assignable to type 'string'.";
    const errs = parseTscOutput(out);
    expect(errs).toHaveLength(1);
    expect(errs[0].code).toBe('E120');
    expect(errs[0].location).toEqual({ file: 'workflows/ci.ts', line: 12, column: 5 });
    expect(errs[0].message).toContain('TS2322');
  });

  it('maps a global (unlocated) tsc diagnostic to an E120 without a location', () => {
    const errs = parseTscOutput("error TS5083: Cannot read file 'tsconfig.json'.");
    expect(errs).toHaveLength(1);
    expect(errs[0].code).toBe('E120');
    expect(errs[0].location).toBeUndefined();
    expect(errs[0].message).toContain('TS5083');
  });

  it('collects multiple diagnostics across lines', () => {
    const out = [
      "workflows/a.ts(1,1): error TS1005: ';' expected.",
      "workflows/b.ts(3,9): error TS2304: Cannot find name 'foo'.",
    ].join('\n');
    expect(parseTscOutput(out)).toHaveLength(2);
  });

  it('ignores non-diagnostic noise lines', () => {
    expect(parseTscOutput('Files: 3\nDone.\n')).toHaveLength(0);
  });
});

describe('runTypecheck', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(import.meta.dirname, '.test-tc-'));
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('skips (ran: false) when there is no tsconfig.json (JavaScript mode)', async () => {
    const result = await runTypecheck(tempDir);
    expect(result.ran).toBe(false);
    expect(result.errors).toEqual([]);
  });
});

describe('resolveLocalTsc', () => {
  let tempDir: string;
  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(import.meta.dirname, '.test-tsc-'));
  });
  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  async function repo(name: string): Promise<string> {
    const dir = path.join(tempDir, name);
    await fs.mkdir(path.join(dir, '.kici'), { recursive: true });
    await fs.mkdir(path.join(dir, '.git'));
    return dir;
  }

  it('finds the tsc a workspace hoisted to the repository root', async () => {
    const dir = await repo('hoisted');
    await fs.mkdir(path.join(dir, 'node_modules', '.bin'), { recursive: true });
    await fs.writeFile(path.join(dir, 'node_modules', '.bin', 'tsc'), '');
    // fails-when: only .kici/node_modules/.bin/tsc is checked, so an npm member falls
    // back to downloading typescript through npx
    expect(resolveLocalTsc(path.join(dir, '.kici'))).toBe(
      path.join(dir, 'node_modules', '.bin', 'tsc'),
    );
  });

  it('prefers .kici/node_modules/.bin/tsc', async () => {
    const dir = await repo('own');
    for (const base of [dir, path.join(dir, '.kici')]) {
      await fs.mkdir(path.join(base, 'node_modules', '.bin'), { recursive: true });
      await fs.writeFile(path.join(base, 'node_modules', '.bin', 'tsc'), '');
    }
    expect(resolveLocalTsc(path.join(dir, '.kici'))).toBe(
      path.join(dir, '.kici', 'node_modules', '.bin', 'tsc'),
    );
  });

  it('stops at the repository root', async () => {
    // Positive control: a tsc exists above the fixture (this monorepo's hoisted one),
    // so a walk that ignored .git would find it.
    const repoRoot = path.resolve(import.meta.dirname, '..', '..', '..', '..');
    expect(existsSync(path.join(repoRoot, 'node_modules', '.bin', 'tsc'))).toBe(true);
    const dir = await repo('bounded');
    // breaks-if-wrong: a tsc outside the repository would type-check its workflows
    expect(resolveLocalTsc(path.join(dir, '.kici'))).toBeNull();
  });
});

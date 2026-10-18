import { afterAll, describe, expect, it } from 'vitest';
import { rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import ts from 'typescript';
import { generateSampleFixture } from '../default-branch.js';
import { makeSdkTypecheckDir, typecheckAgainstSdk } from './sdk-typecheck.test-helpers.js';

/** Branch names git accepts, with the export name the sample fixture must get. */
const BRANCHES: ReadonlyArray<readonly [branch: string, exportName: string]> = [
  ['main', 'pushMain'],
  ['ci/kici', 'pushCiKici'],
  ["feat/it's-x", 'pushFeatItSX'],
  ['release-1.2', 'pushRelease12'],
  ['café/naïve', 'pushCafeNaive'],
];

interface GeneratedLiterals {
  exportNames: string[];
  fixtureIds: string[];
  branches: string[];
  fixtureBranches: string[];
}

/** The names and string values a parser reads back out of generated source. */
function literalsOf(fileName: string, source: string): GeneratedLiterals {
  const found: GeneratedLiterals = {
    exportNames: [],
    fixtureIds: [],
    branches: [],
    fixtureBranches: [],
  };
  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
      found.exportNames.push(node.name.text);
    }
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
      const [first] = node.arguments;
      if (node.expression.text === 'fixture' && first && ts.isStringLiteral(first)) {
        found.fixtureIds.push(first.text);
      }
    }
    if (ts.isPropertyAssignment(node) && ts.isIdentifier(node.name)) {
      const { initializer } = node;
      if (node.name.text === 'branches' && ts.isArrayLiteralExpression(initializer)) {
        for (const el of initializer.elements) {
          if (ts.isStringLiteral(el)) found.branches.push(el.text);
        }
      }
      if (node.name.text === 'branch' && ts.isStringLiteral(initializer)) {
        found.fixtureBranches.push(initializer.text);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(ts.createSourceFile(fileName, source, ts.ScriptTarget.ES2024, true));
  return found;
}

const tmpDir = makeSdkTypecheckDir('kici-default-branch-');

afterAll(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('default-branch scaffold', () => {
  it.each(BRANCHES)('generated literals read back the branch %j exactly', (branch, exportName) => {
    // fails-when: the branch goes into a quoted literal unescaped (`'feat/it's-x'`)
    expect(literalsOf('push-test.ts', generateSampleFixture(branch))).toEqual({
      exportNames: [exportName],
      fixtureIds: [`push-${branch}`],
      branches: [branch],
      // fails-when: the sample fixture leaves its branch to the checkout, so push-main
      // runs as a push to whatever branch the developer is on
      fixtureBranches: [branch],
    });
  });

  it('quotes the fixture ID in the "Run with" line only when a shell needs it', () => {
    // fails-when: the line prints `push-feat/it's-x` bare, which a shell cannot run
    expect(generateSampleFixture("feat/it's-x")).toContain(
      "Run with: kici run remote 'push-feat/it'\\''s-x'",
    );
    // breaks-if-wrong: an ordinary branch stays unquoted
    expect(generateSampleFixture('ci/kici')).toContain('Run with: kici run remote push-ci/kici\n');
  });

  // Builds a TypeScript program over the whole SDK source tree: budgeted like
  // the agents-md snippet check, not left to the package-wide 15s timeout.
  it('every generated fixture type-checks against the real SDK', () => {
    const files = BRANCHES.map(([branch], i) => {
      const fixtureFile = resolve(tmpDir, `push-test-${i}.ts`);
      writeFileSync(fixtureFile, generateSampleFixture(branch), 'utf-8');
      return fixtureFile;
    });
    const rendered = typecheckAgainstSdk(files).join('\n');
    // fails-when: the export name is not an identifier (`export const pushCi/kici = …`)
    expect(rendered, `generated scaffold failed type-check:\n${rendered}`).toBe('');
  }, 120_000);
});

import { afterAll, describe, expect, it } from 'vitest';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import ts from 'typescript';
import { workflowPaths } from '../index.js';
import { scaffoldPrChecks, tsSingleQuoted } from '../pr-checks-scaffold.js';
import { makeSdkTypecheckDir, typecheckAgainstSdk } from './sdk-typecheck.test-helpers.js';

const BRANCHES = ['main', 'develop', 'ci/kici', "feat/it's-x", 'back\\slash', 'café/naïve'];

const template = readFileSync(workflowPaths['pr-checks'], 'utf-8');
const tmpDir = makeSdkTypecheckDir('kici-pr-checks-');

afterAll(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

/** The value of the first string literal in `source`, as a parser reads it. */
function stringLiteralValue(source: string): string | undefined {
  let value: string | undefined;
  const visit = (node: ts.Node): void => {
    if (value === undefined && ts.isStringLiteral(node)) value = node.text;
    ts.forEachChild(node, visit);
  };
  visit(ts.createSourceFile('x.ts', source, ts.ScriptTarget.ES2024, true));
  return value;
}

interface PrChecksShape {
  prTargets: string[];
  prOptionNames: string[];
  ruleLabels: string[];
  sdkImports: string[];
}

/** What a parser reads back out of a scaffolded pr-checks workflow. */
function readBack(source: string): PrChecksShape {
  const found: PrChecksShape = { prTargets: [], prOptionNames: [], ruleLabels: [], sdkImports: [] };
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
      const [first] = node.arguments;
      const callee = node.expression.text;
      if (callee === 'pr' && first && ts.isObjectLiteralExpression(first)) {
        for (const prop of first.properties) {
          if (!ts.isPropertyAssignment(prop) || !ts.isIdentifier(prop.name)) continue;
          found.prOptionNames.push(prop.name.text);
          if (prop.name.text === 'target' && ts.isStringLiteral(prop.initializer)) {
            found.prTargets.push(prop.initializer.text);
          }
        }
      }
      if ((callee === 'rule' || callee === 'skip') && first && ts.isStringLiteral(first)) {
        found.ruleLabels.push(first.text);
      }
    }
    if (
      ts.isImportDeclaration(node) &&
      ts.isStringLiteral(node.moduleSpecifier) &&
      node.moduleSpecifier.text === '@kici-dev/sdk' &&
      node.importClause?.namedBindings &&
      ts.isNamedImports(node.importClause.namedBindings)
    ) {
      for (const el of node.importClause.namedBindings.elements)
        found.sdkImports.push(el.name.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(ts.createSourceFile('pr-checks.ts', source, ts.ScriptTarget.ES2024, true));
  return found;
}

describe('tsSingleQuoted', () => {
  it.each(BRANCHES)('%j parses back to the same string', (branch) => {
    const literal = tsSingleQuoted(branch);
    expect(literal.startsWith("'") && literal.endsWith("'")).toBe(true);
    // fails-when: a ' or \ is not escaped, so the literal ends early or changes value
    expect(stringLiteralValue(`const x = ${literal};`)).toBe(branch);
  });
});

describe('scaffoldPrChecks', () => {
  it('keeps the template byte for byte for a main repository with src/', () => {
    // breaks-if-wrong: the common case must not churn the scaffold
    expect(scaffoldPrChecks(template, { defaultBranch: 'main', hasSrcDir: true })).toBe(template);
  });

  it.each(BRANCHES.flatMap((b) => [[b, true] as const, [b, false] as const]))(
    'branch %j, src/ %s',
    (branch, hasSrcDir) => {
      const shape = readBack(scaffoldPrChecks(template, { defaultBranch: branch, hasSrcDir }));
      // fails-when: the target is not the default branch the caller passes
      expect(shape.prTargets).toEqual([branch]);
      // fails-when: the paths filter survives in a repository with no src/
      expect(shape.prOptionNames).toEqual(hasSrcDir ? ['target', 'paths'] : ['target']);
      // fails-when: require-src-changes survives with no src/
      // breaks-if-wrong: skip-draft-prs must survive the no-src/ variant
      expect(shape.ruleLabels).toEqual(
        hasSrcDir ? ['skip-draft-prs', 'require-src-changes'] : ['skip-draft-prs'],
      );
      // fails-when: the rule import is left behind with the rule removed
      expect(shape.sdkImports.includes('rule')).toBe(hasSrcDir);
    },
  );

  it('writes the target in single quotes', () => {
    // fails-when: the target goes in through JSON.stringify (`target: "develop"`)
    expect(scaffoldPrChecks(template, { defaultBranch: 'develop', hasSrcDir: true })).toContain(
      "on: pr({ target: 'develop', paths: ['src/**'] }),",
    );
    expect(scaffoldPrChecks(template, { defaultBranch: 'develop', hasSrcDir: false })).toContain(
      "on: pr({ target: 'develop' }),",
    );
  });

  it('throws when the template drifts from an anchor', () => {
    // fails-when: a missing anchor is a silent no-op (what the old rewrite did)
    expect(() =>
      scaffoldPrChecks(template.replace("paths: ['src/**']", "paths: ['lib/**']"), {
        defaultBranch: 'main',
        hasSrcDir: false,
      }),
    ).toThrow(/anchor "pr-trigger" found 0 times/);
    // fails-when: a repeated anchor is edited in only one place
    expect(() =>
      scaffoldPrChecks(template + template, { defaultBranch: 'main', hasSrcDir: true }),
    ).toThrow(/found 2 times/);
  });

  it('every variant type-checks against the SDK with noUnusedLocals', () => {
    const templateFile = resolve(tmpDir, 'pr-checks-template.ts');
    writeFileSync(templateFile, template, 'utf-8');
    // Positive control: the option is live and the untouched template passes it.
    expect(typecheckAgainstSdk([templateFile], { noUnusedLocals: true }).join('\n')).toBe('');

    const files = BRANCHES.flatMap((branch, i) =>
      [true, false].map((hasSrcDir) => {
        const file = resolve(tmpDir, `pr-checks-${i}-${hasSrcDir ? 'src' : 'nosrc'}.ts`);
        writeFileSync(
          file,
          scaffoldPrChecks(template, { defaultBranch: branch, hasSrcDir }),
          'utf-8',
        );
        return file;
      }),
    );
    const rendered = typecheckAgainstSdk(files, { noUnusedLocals: true }).join('\n');
    // fails-when: the rule import is left behind with the rule removed (TS6133)
    expect(rendered, `scaffolded pr-checks failed type-check:\n${rendered}`).toBe('');
  }, 120_000);
});

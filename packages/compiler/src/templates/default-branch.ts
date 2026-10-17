/**
 * Default-branch customization for the `kici init` scaffold: the sample push
 * fixture, and the PR target in the workflow templates.
 */

import { shQuote } from '@kici-dev/core';
import { toIdentifier } from '../generators/identifier.js';

/** The branch the workflow templates target as written. */
const TEMPLATE_DEFAULT_BRANCH = 'main';

/** The `pr()` option in the pr-checks template that names the default branch. */
const TEMPLATE_PR_TARGET = `target: '${TEMPLATE_DEFAULT_BRANCH}'`;

/** A fixture ID a POSIX shell reads as one word without quoting. */
const SHELL_WORD = /^[\w./@+-]+$/;

/**
 * Point a workflow template's PR target at the repository's default branch.
 * The branch goes in as a JSON string literal, so a quote or a backslash in its
 * name cannot end the string.
 */
export function rewriteTemplateDefaultBranch(content: string, defaultBranch: string): string {
  if (defaultBranch === TEMPLATE_DEFAULT_BRANCH) return content;
  return content.replaceAll(TEMPLATE_PR_TARGET, `target: ${JSON.stringify(defaultBranch)}`);
}

/**
 * The sample push fixture for `.kici/tests/push-test.ts`. Its ID is
 * `push-<branch>`, and its export name is built from the branch name
 * (`ci/kici` gives `pushCiKici`).
 */
export function generateSampleFixture(defaultBranch: string): string {
  const fixtureId = `push-${defaultBranch}`;
  const runArg = SHELL_WORD.test(fixtureId) ? fixtureId : shQuote(fixtureId);
  return `import { fixture, push } from '@kici-dev/sdk';

/**
 * Sample test fixture: push to the ${defaultBranch} branch.
 *
 * Run with: kici run remote ${runArg}
 * List all:  kici run remote
 */
export const ${toIdentifier('push', defaultBranch)} = fixture(${JSON.stringify(fixtureId)}, {
  event: push({ branches: [${JSON.stringify(defaultBranch)}] }),
});
`;
}

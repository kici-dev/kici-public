/**
 * The sample push fixture `kici init` writes to `.kici/tests/push-test.ts`.
 */

import { shQuote } from '@kici-dev/core';
import { toIdentifier } from '../generators/identifier.js';

/** A fixture ID a POSIX shell reads as one word without quoting. */
const SHELL_WORD = /^[\w./@+-]+$/;

/**
 * The sample push fixture for `.kici/tests/push-test.ts`. Its ID is
 * `push-<branch>`, and its export name is built from the branch name
 * (`ci/kici` gives `pushCiKici`). It pins `branch`, so the event is a push to
 * that branch whichever branch is checked out when the fixture runs. `kici init`
 * passes the branch checked out at scaffold time.
 */
export function generateSampleFixture(branch: string): string {
  const fixtureId = `push-${branch}`;
  const runArg = SHELL_WORD.test(fixtureId) ? fixtureId : shQuote(fixtureId);
  return `import { fixture, push } from '@kici-dev/sdk';

/**
 * Sample test fixture: push to the ${branch} branch.
 *
 * Run with: kici run remote ${runArg}
 * List all:  kici run remote
 */
export const ${toIdentifier('push', branch)} = fixture(${JSON.stringify(fixtureId)}, {
  event: push({ branches: [${JSON.stringify(branch)}] }),
  // The event's branch. Without it, the run uses the branch you have checked out.
  branch: ${JSON.stringify(branch)},
});
`;
}
